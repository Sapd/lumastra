// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    deriveMasterKey,
    isAadBound,
    isSealed,
    openSecret,
    sealSecret,
} from '$lib/server/crypto/secret-box.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { buildXtreamUrls } from '$lib/server/services/livetv/xtream-client.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { StoreRotationResult } from '$lib/server/tasks/secrets.js';

const logger = Logger.for('LiveTvSourcesQueries');

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type LiveTvSourceType = 'm3u' | 'xtream' | 'hdhomerun';

export interface LiveTvSourceRow {
    id: string;
    name: string;
    source_type: LiveTvSourceType;
    m3u_url: string | null;
    xmltv_url: string | null;
    xtream_server: string | null;
    xtream_username: string | null;
    xtream_password: string | null;
    hdhomerun_device_ip: string | null;
    hdhomerun_device_id: string | null;
    max_streams: number;
    refresh_cron: string | null;
    last_refresh_at: Date | null;
    last_refresh_status: string | null;
    last_refresh_summary: unknown;
    created_at: Date;
    updated_at: Date;
}

export interface LiveTvSourceSafeRow {
    id: string;
    name: string;
    source_type: LiveTvSourceType;
    max_streams: number;
    refresh_cron: string | null;
    last_refresh_at: Date | null;
    last_refresh_status: string | null;
    last_refresh_summary: unknown;
    created_at: Date;
    updated_at: Date;
}

export interface LiveTvSourceAdminRow extends LiveTvSourceSafeRow {
    m3u_url: string | null;
    xmltv_url: string | null;
}

export interface CreateSourceParams {
    name: string;
    source_type: LiveTvSourceType;
    m3u_url?: string | null;
    xmltv_url?: string | null;
    xtream_server?: string | null;
    xtream_username?: string | null;
    xtream_password?: string | null;
    hdhomerun_device_ip?: string | null;
    hdhomerun_device_id?: string | null;
    max_streams?: number;
    refresh_cron?: string | null;
}

export interface UpdateSourceParams {
    name?: string;
    source_type?: LiveTvSourceType;
    m3u_url?: string | null;
    xmltv_url?: string | null;
    xtream_server?: string | null;
    xtream_username?: string | null;
    xtream_password?: string | null;
    hdhomerun_device_ip?: string | null;
    hdhomerun_device_id?: string | null;
    max_streams?: number;
    refresh_cron?: string | null;
}

// ---------------------------------------------------------------------------
// Credentials at rest (security review 2026-09-12, C8)
// ---------------------------------------------------------------------------
//
// An Xtream subscription is a paid credential, and this table used to hold it in
// the clear TWICE: once in `xtream_username`/`xtream_password`, and once more
// inside `m3u_url`/`xmltv_url`, which were persisted in their credentialed
// `?username=&password=` form. Anyone with a dump, a replica, a backup or a
// read-only role could `SELECT` a working subscription out of it — while every
// other credential store in the app (plugin secrets, Subsonic tokens, webhook
// secrets, settings.json) is already sealed with the master key, which lives on
// the app host and not in the database.
//
// So: the two credential columns are sealed with `enc:v1:` envelopes before every
// write, and the URLs are stored in their BARE form. The credentialed URLs the
// fetchers need are rebuilt on the one read path that is allowed to see
// credentials (`getSourceByIdWithCredentials`).
//
// Legacy rows keep working in both directions: a column that is not an envelope
// is read as plaintext, and a URL that still carries credentials is used as-is
// when it cannot be rebuilt. Either way the NEXT write re-seals and re-bares the
// row, so installs converge without a migration (the columns are `text`, and an
// envelope is just a longer string).

let cachedMasterKey: Buffer | null = null;

/** Returns null when no master key can be derived — callers then stay on plaintext. */
function masterKey(): Buffer | null {
    if (cachedMasterKey) return cachedMasterKey;
    try {
        cachedMasterKey = deriveMasterKey(resolveMasterKey());
        return cachedMasterKey;
    } catch (err) {
        logger.warn('No master key available; LiveTV credentials stay in plaintext at rest', {
            error: String(err),
        });
        return null;
    }
}

export type XtreamCredentialColumn = 'xtream_username' | 'xtream_password';

/**
 * AAD context binding a sealed credential to its own source row AND its own
 * column (security review 2026-09-13, C19). Store name first, as every context
 * in the app is (see crypto/secret-box.ts); then the source id, the stable row
 * identity for the life of the row; then the column, so a username envelope
 * cannot be swapped into the password column of the same row.
 */
export function credentialContext(sourceId: string, column: XtreamCredentialColumn): string {
    return `livetv_sources:${sourceId.toLowerCase()}/${column}`;
}

/**
 * Seal a credential for storage. Never throws: failing here would mean an
 * operator cannot save a Live TV source at all, so an unsealable value falls
 * back to the previous plaintext behaviour (loudly).
 *
 * An already-sealed value is passed through untouched — including a legacy
 * `enc:v1:` one, which carries no row context and therefore cannot be re-bound
 * without opening it first. Rotation is the upgrade path for those.
 */
function sealCredential(
    sourceId: string,
    column: XtreamCredentialColumn,
    value: string | null | undefined,
): string | null {
    if (value === undefined || value === null || value === '') return value ?? null;
    if (isSealed(value)) return value;
    const key = masterKey();
    if (!key) return value;
    try {
        return sealSecret(value, key, credentialContext(sourceId, column));
    } catch (err) {
        logger.warn('Could not seal LiveTV credential; storing plaintext', { error: String(err) });
        return value;
    }
}

/**
 * Recover a credential from a stored column, sealed or legacy plaintext.
 * An envelope that will not open (rotated or mismatched master key) yields null
 * rather than the raw ciphertext — the fetch then fails upstream, which is the
 * honest outcome.
 */
function openCredential(
    sourceId: string,
    column: XtreamCredentialColumn,
    stored: string | null,
): string | null {
    if (!stored) return stored;
    if (!isSealed(stored)) return stored; // legacy plaintext — re-sealed on next write
    const key = masterKey();
    if (!key) return null;
    try {
        return openSecret(stored, key, credentialContext(sourceId, column)) || null;
    } catch (err) {
        logger.warn('Could not open sealed LiveTV credential; source will fail to refresh', {
            error: String(err),
        });
        return null;
    }
}

/**
 * Re-seal both Xtream credential columns from `oldMasterKey` to `newMasterKey`
 * (security review 2026-09-12, C9 — the rotation counterpart of C8's sealing
 * above).
 *
 * Without this, an operator who rotated the master key and swapped
 * LUMASTRA_MASTER_KEY would find every Xtream source silently unable to refresh:
 * `openCredential` returns null for an envelope it cannot open, so the fetch
 * fails upstream with no indication that the cause was the key.
 *
 * Legacy plaintext columns are left alone deliberately. They are not ciphertext,
 * so there is nothing to move, and `sealCredential` seals them on the next write
 * — sealing them here would be a behaviour change smuggled into a rotation.
 *
 * Per-row and idempotent: a value that already opens under the NEW key and is
 * already bound to its row is counted as rotated and left alone, so re-running
 * after a partial failure finishes the job instead of corrupting the rows that
 * did succeed. A legacy `enc:v1:` envelope IS rewritten even when it already
 * opens under the new key — rotation is the upgrade path to the row-bound
 * `enc:v2:` form (security review 2026-09-13, C19).
 */
export async function rotateLiveTvCredentials(
    sql: postgres.Sql,
    oldMasterKey: Buffer,
    newMasterKey: Buffer,
): Promise<StoreRotationResult> {
    const rows = await sql<
        { id: string; xtream_username: string | null; xtream_password: string | null }[]
    >`
        SELECT id::text, xtream_username, xtream_password
        FROM livetv_sources
        WHERE xtream_username IS NOT NULL OR xtream_password IS NOT NULL
    `;

    let rotated = 0;
    let skipped = 0;
    let legacyUpgraded = 0;
    const reasons: string[] = [];

    for (const row of rows) {
        const next: { xtream_username: string | null; xtream_password: string | null } = {
            xtream_username: row.xtream_username,
            xtream_password: row.xtream_password,
        };
        // Staged by the single UPDATE below, and therefore NOT yet rotated.
        // Both counters are credited only once that statement succeeds —
        // crediting them here and compensating afterwards mis-reported a failed
        // write as a rotation (and, worse, as a binding that never happened).
        let pendingRotated = 0;
        let pendingLegacy = 0;
        let failed = false;

        for (const column of ['xtream_username', 'xtream_password'] as const) {
            const stored = row[column];
            // Empty, or legacy plaintext — no ciphertext to move.
            if (!stored || !isSealed(stored)) continue;

            const context = credentialContext(row.id, column);

            // Already under the new key AND already bound to this row+column:
            // a re-run of a partial rotation has nothing to do here. Counted
            // straight away — there is no write that could fail.
            let plain: string | null = null;
            try {
                plain = openSecret(stored, newMasterKey, context);
                if (isAadBound(stored)) {
                    rotated++;
                    continue;
                }
            } catch {
                // Not yet under the new key — fall through to the old-key path.
            }

            try {
                plain ??= openSecret(stored, oldMasterKey, context);
                next[column] = sealSecret(plain, newMasterKey, context);
                pendingRotated++;
                if (!isAadBound(stored)) pendingLegacy++;
            } catch (err) {
                failed = true;
                reasons.push(
                    `livetv_sources.${column} id=${row.id}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }

        if (failed) skipped++;
        if (pendingRotated === 0) continue;

        // Both columns in ONE statement: a source whose username moved and whose
        // password did not is a source that cannot authenticate at all.
        try {
            await sql`
                UPDATE livetv_sources
                SET xtream_username = ${next.xtream_username},
                    xtream_password = ${next.xtream_password}
                WHERE id = ${row.id}::uuid
            `;
            rotated += pendingRotated;
            legacyUpgraded += pendingLegacy;
        } catch (err) {
            skipped++;
            reasons.push(
                `livetv_sources id=${row.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Self-heal THIS process; other replicas need the env swap and a restart —
    // see docs/security/master-key-rotation.md.
    if (rotated > 0 && skipped === 0) cachedMasterKey = newMasterKey;

    return { rotated, skipped, reasons, legacyUpgraded };
}

/**
 * Drop `username`/`password` query parameters and any URL userinfo, leaving the
 * rest of the URL (path, other parameters) intact. Applied to xtream URLs before
 * they are written, and to every URL leaving the credential-free read path.
 */
function stripUrlCredentials(url: string | null | undefined): string | null {
    if (!url) return url ?? null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return url; // not a URL we can reason about — leave it exactly as-is
    }
    let changed = false;
    for (const param of ['username', 'password']) {
        if (parsed.searchParams.has(param)) {
            parsed.searchParams.delete(param);
            changed = true;
        }
    }
    if (parsed.username || parsed.password) {
        parsed.username = '';
        parsed.password = '';
        changed = true;
    }
    if (!changed) return url;
    // A URL whose only parameters were credentials must not keep a bare '?'.
    return parsed.toString().replace(/\?$/, '');
}

/**
 * Put the credentials back into the stored bare URLs so the import/refresh
 * fetchers get a working provider URL. `buildXtreamUrls` stays the single source
 * of truth for the URL shape; a legacy row without `xtream_server` (or without
 * openable credentials) keeps whatever was stored.
 */
function withXtreamFetchUrls(row: LiveTvSourceRow): LiveTvSourceRow {
    if (row.source_type !== 'xtream') return row;
    if (!row.xtream_server || !row.xtream_username || !row.xtream_password) return row;
    try {
        const urls = buildXtreamUrls({
            serverUrl: row.xtream_server,
            username: row.xtream_username,
            password: row.xtream_password,
        });
        return {
            ...row,
            m3u_url: urls.m3uUrl,
            // Only rebuild an XMLTV URL for a source that actually had one — a
            // source with EPG deliberately left off must not gain one here.
            xmltv_url: row.xmltv_url ? urls.xmltvUrl : row.xmltv_url,
        };
    } catch {
        return row; // malformed stored server URL — leave the row untouched
    }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getAllSources(sql: postgres.Sql): Promise<LiveTvSourceSafeRow[]> {
    return sql<LiveTvSourceSafeRow[]>`
		SELECT id, name, source_type, max_streams, refresh_cron,
		       last_refresh_at, last_refresh_status, last_refresh_summary,
		       created_at, updated_at
		FROM livetv_sources
		ORDER BY created_at ASC
	`;
}

export async function getSourceById(
    sql: postgres.Sql,
    sourceId: string,
): Promise<LiveTvSourceAdminRow | null> {
    const rows = await sql<LiveTvSourceAdminRow[]>`
		SELECT id, name, source_type, m3u_url, xmltv_url,
		       max_streams, refresh_cron,
		       last_refresh_at, last_refresh_status, last_refresh_summary,
		       created_at, updated_at
		FROM livetv_sources
		WHERE id = ${sourceId}
	`;
    const row = rows[0];
    if (!row) return null;
    // Credential-free read path: a legacy row may still carry `?username=&password=`
    // in its stored URL, and this row type is what the admin surfaces see.
    return {
        ...row,
        m3u_url: stripUrlCredentials(row.m3u_url),
        xmltv_url: stripUrlCredentials(row.xmltv_url),
    };
}

export async function getSourceByIdWithCredentials(
    sql: postgres.Sql,
    sourceId: string,
): Promise<LiveTvSourceRow | null> {
    const rows = await sql<LiveTvSourceRow[]>`
		SELECT id, name, source_type, m3u_url, xmltv_url,
		       xtream_server, xtream_username, xtream_password,
		       hdhomerun_device_ip, hdhomerun_device_id,
		       max_streams, refresh_cron,
		       last_refresh_at, last_refresh_status, last_refresh_summary,
		       created_at, updated_at
		FROM livetv_sources
		WHERE id = ${sourceId}
	`;
    const row = rows[0];
    if (!row) return null;
    // The ONE path allowed to see credentials: open the sealed columns and put
    // them back into the fetch URLs the import/refresh services use.
    return withXtreamFetchUrls({
        ...row,
        xtream_username: openCredential(sourceId, 'xtream_username', row.xtream_username),
        xtream_password: openCredential(sourceId, 'xtream_password', row.xtream_password),
    });
}

export async function createSource(
    sql: postgres.Sql,
    params: CreateSourceParams,
): Promise<LiveTvSourceSafeRow> {
    // An xtream source's URLs are derivable from `xtream_server` + the sealed
    // credentials, so only the bare form is persisted. A plain M3U/HDHomeRun URL
    // is whatever the operator typed and is stored verbatim — some providers
    // legitimately authenticate by query parameter and we must not break them.
    const bareUrls = params.source_type === 'xtream';
    // The id is generated HERE, not by the column default: the credentials are
    // sealed bound to it (security review 2026-09-13, C19), so it has to exist
    // before the INSERT rather than come back from it.
    const sourceId = randomUUID();
    const rows = await sql<LiveTvSourceSafeRow[]>`
		INSERT INTO livetv_sources (
			id, name, source_type, m3u_url, xmltv_url,
			xtream_server, xtream_username, xtream_password,
			hdhomerun_device_ip, hdhomerun_device_id,
			max_streams, refresh_cron
		)
		VALUES (
			${sourceId}::uuid,
			${params.name},
			${params.source_type},
			${bareUrls ? stripUrlCredentials(params.m3u_url) : (params.m3u_url ?? null)},
			${bareUrls ? stripUrlCredentials(params.xmltv_url) : (params.xmltv_url ?? null)},
			${params.xtream_server ?? null},
			${sealCredential(sourceId, 'xtream_username', params.xtream_username)},
			${sealCredential(sourceId, 'xtream_password', params.xtream_password)},
			${params.hdhomerun_device_ip ?? null},
			${params.hdhomerun_device_id ?? null},
			${params.max_streams ?? 1},
			${params.refresh_cron ?? null}
		)
		RETURNING id, name, source_type, max_streams, refresh_cron,
		          last_refresh_at, last_refresh_status, last_refresh_summary,
		          created_at, updated_at
	`;
    if (!rows[0]) throw new Error('INSERT livetv_sources returned no row');
    return rows[0];
}

/** Removing a guide and its source-owned data is one atomic, repeatable edit. */
export async function updateSource(
    sql: postgres.Sql,
    sourceId: string,
    params: UpdateSourceParams,
): Promise<LiveTvSourceSafeRow | null> {
    if (params.xmltv_url !== null) return updateSourceRow(sql, sourceId, params);
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const row = await updateSourceRow(tx, sourceId, params);
        if (!row) return null;
        await tx`DELETE FROM livetv_programs WHERE channel_id IN
            (SELECT id FROM livetv_channels WHERE source_id = ${sourceId})`;
        await tx`DELETE FROM livetv_epg_channels WHERE source_id = ${sourceId}`;
        await tx`UPDATE livetv_channels SET epg_match_confidence = NULL, epg_match_signals = NULL
            WHERE source_id = ${sourceId}`;
        await tx`UPDATE livetv_sources SET last_refresh_summary = last_refresh_summary - 'epg' WHERE id = ${sourceId}`;
        return row;
    });
}

async function updateSourceRow(
    sql: postgres.Sql,
    sourceId: string,
    params: UpdateSourceParams,
): Promise<LiveTvSourceSafeRow | null> {
    // Same rule as createSource — but the caller must say so, because an UPDATE
    // does not necessarily carry `source_type`. The admin PUT passes the existing
    // row's type for exactly this reason.
    const bareUrls = params.source_type === 'xtream';
    const rows = await sql<LiveTvSourceSafeRow[]>`
		UPDATE livetv_sources
		SET
			name             = ${params.name === undefined ? sql`name` : params.name},
			source_type      = ${params.source_type === undefined ? sql`source_type` : params.source_type},
			m3u_url          = ${params.m3u_url === undefined ? sql`m3u_url` : bareUrls ? stripUrlCredentials(params.m3u_url) : params.m3u_url},
			xmltv_url        = ${params.xmltv_url === undefined ? sql`xmltv_url` : bareUrls ? stripUrlCredentials(params.xmltv_url) : params.xmltv_url},
			xtream_server    = ${params.xtream_server === undefined ? sql`xtream_server` : params.xtream_server},
			xtream_username  = ${params.xtream_username === undefined ? sql`xtream_username` : sealCredential(sourceId, 'xtream_username', params.xtream_username)},
			xtream_password  = ${params.xtream_password === undefined ? sql`xtream_password` : sealCredential(sourceId, 'xtream_password', params.xtream_password)},
			hdhomerun_device_ip = ${params.hdhomerun_device_ip === undefined ? sql`hdhomerun_device_ip` : params.hdhomerun_device_ip},
			hdhomerun_device_id = ${params.hdhomerun_device_id === undefined ? sql`hdhomerun_device_id` : params.hdhomerun_device_id},
			max_streams      = ${params.max_streams === undefined ? sql`max_streams` : params.max_streams},
			refresh_cron     = ${params.refresh_cron === undefined ? sql`refresh_cron` : params.refresh_cron},
			updated_at       = now()
		WHERE id = ${sourceId}
		RETURNING id, name, source_type, max_streams, refresh_cron,
		          last_refresh_at, last_refresh_status, last_refresh_summary,
		          created_at, updated_at
	`;
    return rows[0] ?? null;
}

export interface DeleteSourceResult {
    /** Whether a source row was actually deleted (false = source not found). */
    deleted: boolean;
    /** Number of channels removed along with the source. */
    channelsDeleted: number;
}

/**
 * Delete a source and everything it owns, atomically.
 *
 * A source owns its channels (each is a `media_items` row + a `livetv_channels`
 * row), their programs and watch history, and its backup groups. The
 * `livetv_channels.source_id` and `livetv_backup_groups.source_id` FKs are
 * `ON DELETE SET NULL`, so deleting only the source row would orphan all of it
 * (channels left behind with `source_id = NULL`, unplayable and unrefreshable).
 * We therefore delete the dependents explicitly, in one transaction:
 *
 *  - Deleting the channels' `media_items` rows cascades (`ON DELETE CASCADE`) to
 *    `livetv_channels` → `livetv_programs` + `livetv_channel_watch_history`.
 *  - Backup groups are deleted explicitly (also `SET NULL` otherwise).
 *  - `livetv_epg_channels` already cascade on the source delete.
 *  - Shared `livetv_categories` are intentionally left intact (not source-owned).
 */
export async function deleteSource(
    sql: postgres.Sql,
    sourceId: string,
): Promise<DeleteSourceResult> {
    return withTx(sql, async (tx) => {
        // hls_playback_tokens.media_item_id → media_items has NO on-delete rule
        // (NO ACTION) — the one FK to media_items that doesn't cascade. An active
        // stream (or a lingering token) on one of these channels would otherwise
        // FK-block the media_items delete and roll back the whole transaction, so
        // the source could never be removed while it's being watched. Clear those
        // tokens first; the streams are being torn down with the channels anyway.
        await tx`
			DELETE FROM hls_playback_tokens
			WHERE media_item_id IN (SELECT id FROM livetv_channels WHERE source_id = ${sourceId})
		`;
        // The Failures tab kept listing a deleted source's stream failures
        // (channel_id is plain text, no FK). A re-import replaces the channel
        // rows but keeps this history; deleting the source ends it, including
        // events of channel ids earlier re-imports already replaced (no channel
        // has those ids any more).
        await tx`
			DELETE FROM livetv_stream_failure_events e
			WHERE e.channel_id IN (SELECT id::text FROM livetv_channels WHERE source_id = ${sourceId})
			   OR NOT EXISTS (SELECT 1 FROM livetv_channels c WHERE c.id::text = e.channel_id)
		`;
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- destructive source cleanup behind an operator-gated route; scoped to this source's own channels, not a user-facing read
        const channelsResult = await tx`
			DELETE FROM media_items
			WHERE id IN (SELECT id FROM livetv_channels WHERE source_id = ${sourceId})
		`;
        await tx`DELETE FROM livetv_backup_groups WHERE source_id = ${sourceId}`;
        // Categories only this source's channels used (shared ones stay).
        await tx`
			DELETE FROM livetv_categories cat
			WHERE NOT EXISTS (SELECT 1 FROM livetv_channels c WHERE c.category_id = cat.id)
		`;
        const sourceResult = await tx`DELETE FROM livetv_sources WHERE id = ${sourceId}`;
        return {
            deleted: sourceResult.count > 0,
            channelsDeleted: channelsResult.count,
        };
    });
}

export async function updateRefreshStatus(
    sql: postgres.Sql,
    sourceId: string,
    status: string,
    summary: unknown,
): Promise<boolean> {
    const result = await sql`
		UPDATE livetv_sources
		SET
			last_refresh_at      = now(),
			last_refresh_status  = ${status},
			last_refresh_summary = ${sql.json(summary as postgres.JSONValue)}::jsonb ||
                CASE WHEN last_refresh_summary ? 'epg'
                     THEN jsonb_build_object('epg', last_refresh_summary->'epg') ELSE '{}'::jsonb END,
			updated_at           = now()
		WHERE id = ${sourceId}
	`;
    return result.count > 0;
}

/** Guide state is independent: never move the playlist clock or overwrite its summary. */
export async function updateEpgRefreshStatus(
    sql: postgres.Sql,
    sourceId: string,
    status: string,
    summary: Record<string, unknown>,
): Promise<boolean> {
    const result = await sql`UPDATE livetv_sources
        SET last_refresh_summary = jsonb_set(COALESCE(last_refresh_summary, '{}'::jsonb), '{epg}',
                ${sql.json(summary as postgres.JSONValue)}::jsonb || jsonb_build_object('status', ${status}::text, 'at', now())),
            updated_at = now()
        WHERE id = ${sourceId} AND xmltv_url IS NOT NULL`;
    return result.count > 0;
}

export async function getSourceChannelCount(sql: postgres.Sql, sourceId: string): Promise<number> {
    const rows = await sql<[{ count: string }]>`
		SELECT COUNT(*) AS count
		FROM livetv_channels
		WHERE source_id = ${sourceId}
	`;
    return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Get all sources with non-null refresh_cron (for the cron-sweep task).
 * Includes last_refresh_at and m3u_url so the sweep can decide per-source.
 */
export async function getSourcesWithRefreshCron(sql: postgres.Sql): Promise<
    Array<{
        id: string;
        name: string;
        refresh_cron: string;
        xmltv_url: string | null;
        m3u_url: string | null;
        last_refresh_at: Date | null;
        last_epg_refresh_at?: Date | null;
    }>
> {
    return sql<
        Array<{
            id: string;
            name: string;
            refresh_cron: string;
            xmltv_url: string | null;
            m3u_url: string | null;
            last_refresh_at: Date | null;
            last_epg_refresh_at?: Date | null;
        }>
    >`
		SELECT id, name, refresh_cron, xmltv_url, m3u_url, last_refresh_at,
               NULLIF(last_refresh_summary->'epg'->>'at', '')::timestamptz AS last_epg_refresh_at
		FROM livetv_sources
		WHERE refresh_cron IS NOT NULL
		ORDER BY created_at ASC
	`;
}

export async function getAllSourcesWithChannelCounts(sql: postgres.Sql): Promise<
    (LiveTvSourceSafeRow & {
        channel_count: number;
        tvg_id_count: number;
    })[]
> {
    // tvg_id_count: channels whose playlist entry carried a tvg-id. 0 on a
    // non-empty M3U source means a bare playlist (an Xtream get.php link without
    // type=m3u_plus), which the admin UI flags.
    return sql<
        (LiveTvSourceSafeRow & {
            channel_count: number;
            tvg_id_count: number;
        })[]
    >`
		SELECT s.id, s.name, s.source_type, s.max_streams, s.refresh_cron,
		       s.last_refresh_at, s.last_refresh_status, s.last_refresh_summary,
		       s.created_at, s.updated_at,
		       COALESCE(COUNT(c.id), 0)::int AS channel_count,
		       COUNT(c.epg_channel_id)::int AS tvg_id_count
		FROM livetv_sources s
		LEFT JOIN livetv_channels c ON c.source_id = s.id
		GROUP BY s.id
		ORDER BY s.created_at ASC
	`;
}
