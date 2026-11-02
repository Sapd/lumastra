// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Artwork Queries
 *
 * CRUD for the image_candidates table.
 * One row per (owner, role, provider, reference, language). Storage source is
 * separate from provenance; selected rows drive image serving.
 */
import { deriveImageProvider } from '$lib/shared/image-provenance.js';
import type { ImageCandidate, ImageProvider } from '$lib/schemas/image-candidates.js';
import { clearMusicArtworkProvenance } from './music-enrichment-provenance.queries.js';
import { normalize as normalizePath } from 'node:path';
import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { selectImageCandidate, allowImageProviderRole } from './image-candidates.queries.js';
import type { ArtworkType, ArtworkSource } from '../../utils/media-extras.js';
import { isSeason } from '$lib/server/utils/media-types.js';

/**
 * Canonicalize a file path used as a suppression key so tombstone add/check/clear
 * agree despite cosmetic drift (`//`, `.`, `..`, trailing slash). Applied on BOTH
 * the write and read sides so the same logical file always maps to one key.
 * Deliberately does NOT case-fold or resolve symlinks — that could over-match
 * distinct files; exact bytes after normalization is the safe middle ground.
 */
function suppressionKeyPath(filePath: string): string {
    return normalizePath(filePath);
}

export interface MediaArtworkRow {
    id: string;
    media_item_id: string;
    artwork_type: ArtworkType;
    source: ArtworkSource;
    file_path: string | null;
    remote_url: string | null;
    language: string | null;
    sort_order: number;
    created_at: Date;
    provider?: ImageProvider;
    provider_ref?: string;
    selected?: boolean;
    locked?: boolean;
    chosen_by?: 'auto' | 'admin' | 'user';
    fetched_at?: Date;
    width?: number | null;
    height?: number | null;
}

/**
 * Columns on media_items that mirror a local artwork row's serve URL.
 * `banner` has no corresponding column — omitted intentionally.
 */
const ARTWORK_URL_COLUMN: Partial<Record<ArtworkType, string>> = {
    poster: 'custom_poster_url',
    backdrop: 'custom_backdrop_url',
    logo: 'custom_logo_url',
    thumb: 'custom_thumb_url',
};

/**
 * Upsert a local artwork record.
 * On conflict (same item + role + provider + reference + language) updates the cache path.
 *
 * Also maintains the `media_items.custom_{type}_url` invariant: when a local
 * artwork row exists for a given (item, type), the corresponding column on
 * `media_items` points to the proxy endpoint. Only sets when the column is
 * NULL so user-uploaded or provider URLs (TMDB/Jellyfin) are preserved.
 * This is the single chokepoint for registering local artwork, so enforcing
 * here prevents drift from any write path (file scanner, post-scan, video
 * frame extractor, image scanner, etc.).
 */
/**
 * What an `upsertLocalArtwork` call actually did to the row.
 *
 * `'unchanged'` — a row for this (item, type) already pointed at this exact
 * file with this exact provenance, so the statement DECLINED to write. This is
 * the STEADY STATE for a library scan, which re-walks every poster/fanart
 * sidecar on every cycle: on production ~14,900 artwork rows were re-registered
 * per cycle against 159 genuinely created in 24 hours. It is both the outcome
 * the scan summary must not count as "added" and, since 2026-08-27, the outcome
 * that costs no write at all.
 *
 * `'suppressed'` — the exact file is tombstoned by an admin "Remove", or its
 * provider is suppressed. Distinct from 'unchanged' because the row may not exist at
 * all; the boolean wrapper below maps only this case to `false`.
 */
export type LocalArtworkUpsertOutcome = 'inserted' | 'updated' | 'unchanged' | 'suppressed';

/**
 * Boolean-returning wrapper kept for the ten existing call sites that only ask
 * "did the write land". Widening the return type in place would have been a
 * silent break: every `if (await upsertLocalArtwork(...))` would stay truthy on
 * a suppressed write once the value became an object.
 */
export async function upsertLocalArtwork(
    sql: postgres.Sql,
    params: {
        mediaItemId: string;
        artworkType: ArtworkType;
        filePath: string;
        /** SHA-256 of the bytes measured by the registering service. */
        localContentHash?: string;
        sourceTag?: string;
        chosenBy?: 'admin';
        provider?: ImageProvider;
        providerRef?: string;
        width?: number;
        height?: number;
    },
): Promise<boolean> {
    return (await upsertLocalArtworkWithOutcome(sql, params)) !== 'suppressed';
}

/**
 * ARTWORK LOCK ORDER: every transaction that writes both `image_candidates` and
 * the owning `media_items` row must lock the media_items row(s) FIRST, in id
 * order. The artwork writers here used to delete/upsert the artwork row and
 * then update `custom_*_url`, while `invalidateFileProbeData` updates
 * media_items (segment-generation bump) before deleting the same item's local
 * artwork — opposite orders, 4 deadlocks on prod (2026-09-22..23).
 */
export async function lockArtworkOwners(
    tx: postgres.Sql,
    mediaItemIds: readonly string[],
): Promise<void> {
    const ids = [...new Set(mediaItemIds)];
    if (ids.length === 0) return;
    await tx`
        SELECT 1 FROM media_items
        WHERE id = ANY(${ids}::uuid[])
        ORDER BY id
        FOR NO KEY UPDATE
    `;
}

/**
 * True for the pooled top-level handle: it can open a transaction and is not
 * inside one. A TransactionSql has `.savepoint`; a ReservedSql has neither.
 */
function isTopLevelSql(sql: postgres.Sql): boolean {
    const handle = sql as unknown as { begin?: unknown; savepoint?: unknown };
    return typeof handle.begin === 'function' && typeof handle.savepoint !== 'function';
}

/**
 * True only when {@link upsertLocalArtworkWithOutcome}'s locked path would
 * write nothing and report 'unchanged': the local row for (item, type) exists
 * with this exact file_path, the incoming tag (if any) equals the stored
 * remote_url, the exact file is not tombstoned, and the paired custom_*_url
 * column is already set. Mirrors the upsert's `WHERE` guard and the self-heal
 * UPDATE; any doubt (missing row, tag differs, URL unset) returns false and the
 * caller takes the locked path.
 */
async function isLocalArtworkRegistrationNoop(
    sql: postgres.Sql,
    params: {
        mediaItemId: string;
        artworkType: ArtworkType;
        filePath: string;
        /** SHA-256 of the bytes measured by the registering service. */
        localContentHash?: string;
        sourceTag?: string;
        chosenBy?: 'admin';
        provider?: ImageProvider;
        providerRef?: string;
        width?: number;
        height?: number;
    },
    suppressionPath: string,
): Promise<boolean> {
    const urlCol = ARTWORK_URL_COLUMN[params.artworkType];
    const urlClaimed = urlCol
        ? sql`EXISTS (SELECT 1 FROM media_items WHERE id = ${params.mediaItemId}::uuid AND ${sql(urlCol)} IS NOT NULL)`
        : sql`true`;
    const tag = params.sourceTag ?? null;
    const reuseIdentity = !params.sourceTag && !params.provider && !params.providerRef;
    const incomingProvider =
        params.provider ??
        (params.sourceTag
            ? deriveImageProvider(params.sourceTag, params.filePath)
            : 'local-folder');
    const [row] = await sql<[{ noop: boolean }]>`
        WITH candidate AS (
            -- Resolve exactly the identity the locked registration will reuse,
            -- before testing measurements or suppressions against that identity.
            SELECT * FROM image_candidates
            WHERE media_item_id = ${params.mediaItemId}::uuid
              AND artwork_type = ${params.artworkType} AND file_path = ${params.filePath}
              AND (${reuseIdentity} OR (provider = ${incomingProvider}
                AND provider_ref = ${params.providerRef ?? params.filePath} AND COALESCE(language,'') = ''))
            ORDER BY (chosen_by <> 'auto') DESC, locked DESC,
                CASE WHEN provider IN ('local-folder','unknown') THEN 1 ELSE 0 END, selected DESC, created_at DESC, id LIMIT 1
        )
        SELECT (
            EXISTS (
                SELECT 1 FROM candidate
                WHERE source = 'local'
                  AND (${params.localContentHash ?? null}::text IS NULL OR local_content_hash = ${params.localContentHash ?? null})
                  AND (${params.provider ?? null}::text IS NULL OR provider = ${params.provider ?? null})
                  AND (${params.providerRef ?? null}::text IS NULL OR provider_ref = ${params.providerRef ?? null})
                  AND (${params.width ?? null}::int IS NULL OR width = ${params.width ?? null})
                  AND (${params.height ?? null}::int IS NULL OR height = ${params.height ?? null})
                  AND (
                      ${tag}::text IS NULL
                      OR remote_url IS NOT DISTINCT FROM ${tag}::text
                  )
            )
            AND NOT EXISTS (
                SELECT 1 FROM media_artwork_suppressions
                WHERE media_item_id = ${params.mediaItemId}::uuid
                  AND artwork_type = ${params.artworkType}
                  AND file_path = ${suppressionPath}
            )
            AND NOT EXISTS (
                SELECT 1 FROM image_candidates alias JOIN image_candidates managed
                    ON managed.media_item_id=alias.media_item_id AND managed.artwork_type=alias.artwork_type
                    AND managed.file_path=alias.file_path AND COALESCE(managed.language,'')=COALESCE(alias.language,'')
                WHERE alias.media_item_id=${params.mediaItemId} AND alias.artwork_type=${params.artworkType}
                  AND alias.file_path=${params.filePath} AND alias.provider='local-folder' AND alias.remote_url IS NULL
                  AND alias.chosen_by='auto' AND NOT alias.locked AND alias.provider_ref=alias.file_path
                  AND COALESCE(alias.language,'')=''
                  AND managed.provider NOT IN ('local-folder','unknown') AND managed.chosen_by='auto' AND NOT managed.locked
                  AND NOT EXISTS (SELECT 1 FROM image_candidates choice WHERE choice.media_item_id=alias.media_item_id
                    AND choice.artwork_type=alias.artwork_type AND choice.chosen_by<>'auto')
                  AND NOT EXISTS (SELECT 1 FROM image_provider_suppressions s WHERE s.owner=alias.media_item_id::text
                    AND s.provider IN (alias.provider,managed.provider) AND s.role IN ('*',alias.artwork_type))
            )
            AND NOT EXISTS (SELECT 1 FROM image_provider_suppressions
                WHERE owner=${params.mediaItemId}::text AND provider=(SELECT provider FROM candidate)
                  AND role IN ('*',${params.artworkType}))
            AND ${urlClaimed}
        ) AS noop
    `;
    return row?.noop === true;
}

export async function upsertLocalArtworkWithOutcome(
    sql: postgres.Sql,
    params: {
        mediaItemId: string;
        artworkType: ArtworkType;
        filePath: string;
        /** SHA-256 of the bytes measured by the registering service. */
        localContentHash?: string;
        sourceTag?: string;
        chosenBy?: 'admin';
        provider?: ImageProvider;
        providerRef?: string;
        width?: number;
        height?: number;
    },
): Promise<LocalArtworkUpsertOutcome> {
    // Transactional: INSERT and the paired custom_*_url UPDATE must commit
    // together. If the UPDATE fails after the INSERT commits, drift is
    // silently re-introduced — defeating the whole invariant. Use withTx (not
    // raw sql.begin) so a NESTED call — e.g. album-enrichment wraps the artwork
    // + marker writes in its own withTx and passes us a TransactionSql, which
    // has .savepoint but NO .begin — opens a savepoint instead of throwing
    // "sql.begin is not a function".
    //
    // Returns 'suppressed' when the write was skipped because the exact file is
    // tombstoned (durable Remove), or its provider is suppressed. Callers that
    // count "stored/added" or stamp
    // derived state MUST honor this — a silent skip that reports success would
    // inflate scan stats and leave orphaned metadata.
    //
    // Admin uploads carry an `admin:*` tag; scanner/enrichment writes do not.
    const isAdminWrite =
        params.chosenBy === 'admin' || (params.sourceTag?.startsWith('admin:') ?? false);
    const suppressionPath = suppressionKeyPath(params.filePath);
    let provider =
        params.provider ??
        (params.sourceTag
            ? deriveImageProvider(params.sourceTag, params.filePath)
            : 'local-folder');
    let providerRef = params.providerRef ?? params.filePath;
    let language = '';

    // STEADY-STATE FAST PATH. A library scan re-registers every sidecar every
    // cycle and ~all of them come back 'unchanged' (prod 2026-10-05: 263k
    // owner-row locks in 16 h, each with BEGIN/UPSERT/UPDATE/COMMIT behind it).
    // When ONE read-only statement proves the full transaction below would write
    // nothing — row already exact, no tombstone, serve URL already claimed — the
    // answer is 'unchanged' with no lock, no write and no transaction. The lock
    // exists to order WRITES (see ARTWORK LOCK ORDER); a call that writes nothing
    // cannot take part in a deadlock, and its result is the one the locked path
    // would have produced against the same committed snapshot. Admin writes keep
    // the full path (they must lift a tombstone).
    //
    // TOP-LEVEL CALLS ONLY. Inside a caller's transaction the owner lock is part
    // of that caller's lock order (audio-processor and album-enrichment lock the
    // album through their first upsert, then the track), so a nested call always
    // takes the locked path, exactly as before; it would also read the caller's
    // snapshot rather than the latest committed state. A top-level check that
    // races an uncommitted writer (e.g. an admin Remove) answers as if that
    // writer committed a moment later — an ordering that could already occur —
    // and the next scan sees the committed result.
    if (
        !isAdminWrite &&
        isTopLevelSql(sql) &&
        (await isLocalArtworkRegistrationNoop(sql, params, suppressionPath))
    ) {
        return 'unchanged';
    }

    return await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await lockArtworkOwners(tx, [params.mediaItemId]);
        // Automatic registration/measurement must preserve a curated slot,
        // including a manually curated candidate that is currently unselected.
        // Capture its slot before refreshing content or upgrading aliases; the
        // owner lock keeps the complete transition and restoration atomic.
        const selection = isAdminWrite
            ? []
            : await tx<{ id: string; selected: boolean; selection_order: number }[]>`
            SELECT id,selected,selection_order FROM image_candidates
            WHERE media_item_id=${params.mediaItemId} AND artwork_type=${params.artworkType}
              AND EXISTS (SELECT 1 FROM image_candidates choice WHERE choice.media_item_id=${params.mediaItemId}
                AND choice.artwork_type=${params.artworkType} AND choice.chosen_by<>'auto')`;
        const register = async (): Promise<LocalArtworkUpsertOutcome> => {
            // A scanner knows the path, not who wrote it. Reuse the existing
            // candidate's identity (including language) regardless of its filename,
            // even inside a transaction where the read-only fast path is off.
            if (!params.sourceTag && !params.provider && !params.providerRef) {
                const [existing] = await tx<
                    { provider: ImageProvider; provider_ref: string; language: string | null }[]
                >`
                    SELECT provider, provider_ref, language FROM image_candidates
                    WHERE media_item_id = ${params.mediaItemId} AND artwork_type = ${params.artworkType}
                      AND file_path = ${params.filePath}
                    ORDER BY (chosen_by <> 'auto') DESC, locked DESC,
                        CASE WHEN provider IN ('local-folder','unknown') THEN 1 ELSE 0 END, selected DESC, created_at DESC, id LIMIT 1`;
                if (existing) {
                    provider = existing.provider;
                    providerRef = existing.provider_ref;
                    language = existing.language ?? '';
                }
            }

            if (isAdminWrite) {
                await allowImageProviderRole(tx, params.mediaItemId, provider, params.artworkType);
                // An explicit admin (re)upload of this exact path is an intentional
                // override — lift any tombstone so it isn't self-suppressed.
                await clearArtworkSuppression(
                    tx,
                    params.mediaItemId,
                    params.artworkType,
                    params.filePath,
                );
            }

            if (isAdminWrite) {
                await tx`UPDATE image_candidates SET locked = false
                    WHERE media_item_id = ${params.mediaItemId} AND artwork_type = ${params.artworkType} AND locked`;
            }

            // Consolidate only automatic unlabelled aliases when a safe managed
            // identity already exists. Manual choices and either provider's tombstone
            // prohibit consolidation, even though both candidates share bytes.
            const consolidated = await tx`
                DELETE FROM image_candidates alias USING image_candidates managed
                WHERE alias.media_item_id=${params.mediaItemId} AND alias.artwork_type=${params.artworkType}
                  AND alias.file_path=${params.filePath} AND alias.provider='local-folder' AND alias.provider_ref=alias.file_path
                  AND alias.remote_url IS NULL AND alias.chosen_by='auto' AND NOT alias.locked
                  AND COALESCE(alias.language,'')=''
                  AND managed.media_item_id=alias.media_item_id AND managed.artwork_type=alias.artwork_type
                  AND managed.file_path=alias.file_path AND COALESCE(managed.language,'')=''
                  AND managed.provider=${provider} AND managed.provider_ref=${providerRef}
                  AND managed.provider NOT IN ('local-folder','unknown') AND managed.chosen_by='auto' AND NOT managed.locked
                  AND NOT EXISTS (SELECT 1 FROM image_candidates choice WHERE choice.media_item_id=alias.media_item_id
                    AND choice.artwork_type=alias.artwork_type AND choice.chosen_by<>'auto')
                  AND NOT EXISTS (SELECT 1 FROM media_artwork_suppressions s WHERE s.media_item_id=alias.media_item_id
                    AND s.artwork_type=alias.artwork_type AND s.file_path=${suppressionPath})
                  AND NOT EXISTS (SELECT 1 FROM image_provider_suppressions s WHERE s.owner=alias.media_item_id::text
                    AND s.provider IN (alias.provider,managed.provider) AND s.role IN ('*',alias.artwork_type))
            `;

            // A managed writer can identify the very file previously discovered as
            // an unlabelled sidecar. Upgrade that automatic alias in place rather
            // than leaving a higher-ranked local-folder alias hiding its provenance.
            // Distinct files, manual choices and suppressions remain untouched.
            const upgraded =
                !isAdminWrite &&
                params.sourceTag &&
                provider !== 'local-folder' &&
                provider !== 'unknown'
                    ? await tx`
                        UPDATE image_candidates c
                        SET provider = ${provider}, provider_ref = ${providerRef},
                            remote_url = ${params.sourceTag}, updated_at = now()
                        WHERE c.media_item_id = ${params.mediaItemId} AND c.artwork_type = ${params.artworkType}
                          AND c.file_path = ${params.filePath} AND c.provider = 'local-folder'
                          AND c.provider_ref = ${params.filePath} AND c.remote_url IS NULL
                          AND c.chosen_by = 'auto' AND NOT c.locked AND COALESCE(c.language, '') = ''
                          AND NOT EXISTS (SELECT 1 FROM image_candidates other
                              WHERE other.media_item_id = c.media_item_id AND other.artwork_type = c.artwork_type
                                AND other.provider = ${provider} AND other.provider_ref = ${providerRef}
                                AND COALESCE(other.language, '') = '')
                          AND NOT EXISTS (SELECT 1 FROM media_artwork_suppressions
                              WHERE media_item_id = c.media_item_id AND artwork_type = c.artwork_type AND file_path = ${suppressionPath})
                          AND NOT EXISTS (SELECT 1 FROM image_provider_suppressions
                              WHERE owner = c.media_item_id::text AND provider IN (${provider},c.provider) AND role IN ('*',c.artwork_type))
                    `
                    : undefined;

            // Suppression-guarded insert. The `WHERE NOT EXISTS` folds the tombstone
            // check into the same statement as the write, so it is atomic against a
            // concurrent admin Remove (no check-then-insert TOCTOU). Admin writes
            // cleared their own tombstone above, so they always pass the guard.
            //
            // ONE statement reporting TWO facts, because after the DO UPDATE gained
            // a WHERE below, "no row came back" stopped being a single verdict — it
            // now means EITHER the tombstone blocked the write OR the row was
            // already exactly right. Those must never be confused: the first has to
            // stay a refusal, and answering 'unchanged' there would re-publish
            // artwork an admin removed. Deciding it from a separate read of the row
            // would put the tombstone behind an invariant this function cannot see;
            // the `tombstone` CTE keeps the verdict inside the same snapshot as the
            // write. It is referenced twice, so Postgres materializes it and both
            // uses agree by construction.
            const hashMeasurement =
                params.localContentHash !== undefined &&
                params.sourceTag === undefined &&
                params.provider === undefined &&
                params.providerRef === undefined &&
                params.width === undefined &&
                params.height === undefined;
            const [verdict] = await tx<
                [{ suppressed: boolean; inserted: boolean | null; hash_backfill_only: boolean }]
            >`
                WITH tombstone AS (
                    SELECT 1
                    FROM media_artwork_suppressions
                    WHERE media_item_id = ${params.mediaItemId}
                      AND artwork_type = ${params.artworkType}
                      AND file_path = ${suppressionPath}
                    UNION ALL
                    SELECT 1 FROM image_provider_suppressions
                    WHERE owner = ${params.mediaItemId}::text AND provider = ${provider}
                        AND role IN ('*',${params.artworkType}) AND NOT ${isAdminWrite}
                ),
                existing_enrichment AS (
                    SELECT 1 FROM image_candidates
                    WHERE media_item_id=${params.mediaItemId} AND artwork_type=${params.artworkType}
                      AND provider=${provider} AND provider_ref=${providerRef} AND COALESCE(language,'')=${language}
                      AND source='local' AND file_path=${params.filePath} AND remote_url='album-enrichment'
                      AND local_content_hash IS NULL AND ${hashMeasurement}
                ),
                upserted AS (
                    INSERT INTO image_candidates (media_item_id, artwork_type, source, file_path, remote_url, language,
                        provider, provider_ref, chosen_by, locked, width, height, local_content_hash)
                    SELECT ${params.mediaItemId}, ${params.artworkType}, 'local', ${params.filePath}, ${params.sourceTag ?? null}, ${language},
                        ${provider}, ${providerRef}, ${isAdminWrite ? 'admin' : 'auto'}, ${isAdminWrite}, ${params.width ?? null}, ${params.height ?? null}, ${params.localContentHash ?? null}
                    WHERE NOT EXISTS (SELECT 1 FROM tombstone)
                    ON CONFLICT (media_item_id, artwork_type, provider, provider_ref, COALESCE(language, ''::text))
                    DO UPDATE SET
                        source = 'local',
                        suppressed = CASE WHEN ${isAdminWrite} THEN false ELSE image_candidates.suppressed END,
                        local_content_hash = CASE WHEN EXCLUDED.local_content_hash IS NOT NULL THEN EXCLUDED.local_content_hash
                            WHEN image_candidates.file_path IS NOT DISTINCT FROM EXCLUDED.file_path AND NOT ${isAdminWrite}
                                THEN image_candidates.local_content_hash ELSE NULL END,
                        file_path = EXCLUDED.file_path,
                        chosen_by = CASE WHEN ${isAdminWrite} THEN 'admin' ELSE image_candidates.chosen_by END,
                        locked = CASE WHEN ${isAdminWrite} THEN true ELSE image_candidates.locked END,
                        width = COALESCE(EXCLUDED.width, image_candidates.width),
                        height = COALESCE(EXCLUDED.height, image_candidates.height),
                        -- Provenance survives a tagless re-registration of the SAME file.
                        -- The library scanner calls this with no sourceTag once per scan
                        -- (ancillary-processors.ts:140-144); the old unconditional
                        -- assignment therefore NULLed remote_url on every materialized row
                        -- on the next scan, erasing the 'provider:' tag isManagedArtworkFile
                        -- (media-image-storage.service.ts:79-89) reads and silently turning
                        -- a managed file into an unmanaged sidecar — after which admin
                        -- "Remove" tombstones the row and leaves our file in the user's
                        -- media folder forever.
                        --
                        -- It does NOT survive a re-point at a DIFFERENT file: the tag would
                        -- then claim a file we never wrote, and admin "Remove" would unlink
                        -- the user's own sidecar.
                        remote_url = CASE
                            WHEN EXCLUDED.remote_url IS NOT NULL THEN EXCLUDED.remote_url
                            WHEN image_candidates.file_path IS NOT DISTINCT FROM EXCLUDED.file_path
                                THEN image_candidates.remote_url
                            ELSE EXCLUDED.remote_url
                        END,
                        -- The artwork revision (/j image tags hash it). An admin
                        -- re-upload writes the SAME fixed path, so path + created_at
                        -- alone never change when the picture does.
                        updated_at = now()
                    -- Write nothing when the row already says exactly this. A library
                    -- scan re-walks every poster/fanart sidecar on every cycle, so the
                    -- unguarded DO UPDATE rewrote ~14,900 rows to themselves per cycle,
                    -- ~26 cycles a day, on a 93k-row table.
                    --
                    -- DERIVED from the CASE above, not a copy of it, so the two cannot
                    -- drift. Taking the CASE branch by branch: a tagless re-registration
                    -- of the SAME file resolves back to the stored remote_url and can
                    -- change nothing, which is why no clause is needed for it; the
                    -- ELSE branch only fires when the path differs, which the first
                    -- disjunct has already caught; so the only remaining way to change
                    -- remote_url without changing file_path is an incoming tag.
                    WHERE (NOT image_candidates.locked OR ${isAdminWrite} OR image_candidates.file_path IS NULL OR image_candidates.file_path = EXCLUDED.file_path)
                      AND (image_candidates.file_path IS DISTINCT FROM EXCLUDED.file_path
                       OR EXCLUDED.local_content_hash IS NOT NULL AND image_candidates.local_content_hash IS DISTINCT FROM EXCLUDED.local_content_hash
                       OR (
                            EXCLUDED.remote_url IS NOT NULL
                            AND image_candidates.remote_url IS DISTINCT FROM EXCLUDED.remote_url
                          )
                       -- An admin upload has just written new bytes to this path:
                       -- always record it, even when the row text is unchanged.
                       OR EXCLUDED.width IS DISTINCT FROM image_candidates.width AND EXCLUDED.width IS NOT NULL
                       OR EXCLUDED.height IS DISTINCT FROM image_candidates.height AND EXCLUDED.height IS NOT NULL
                       OR ${isAdminWrite})
                    -- xmax = 0 only on a freshly INSERTed tuple; the DO UPDATE branch
                    -- stamps it with the updating xid. No row at all means the WHERE
                    -- above declined, i.e. nothing needed doing.
                    RETURNING (xmax = 0) AS inserted
                )
                SELECT EXISTS (SELECT 1 FROM tombstone) AS suppressed,
                       (SELECT inserted FROM upserted) AS inserted,
                       EXISTS (SELECT 1 FROM existing_enrichment) AS hash_backfill_only
            `;

            if (verdict.suppressed) {
                // Tombstoned + not an admin write → skipped, so the removal stays
                // durable. Do NOT touch custom_*_url. Checked BEFORE the no-write
                // case below, which is the whole point: a tombstoned file whose row
                // still stands also comes back with no row written, and reading that
                // as 'unchanged' would hand the boolean wrapper a `true`.
                return 'suppressed';
            }

            // Runs on the 'unchanged' path too, deliberately. It is a
            // `WHERE ... IS NULL` update, so it costs nothing once the column is
            // claimed, and it is the only thing that re-publishes the serve URL if
            // anything ever cleared it out from under a row that still stands.
            // Short-circuiting the no-op write past this is how that self-heal gets
            // lost.
            const urlCol = ARTWORK_URL_COLUMN[params.artworkType];
            if (urlCol) {
                const serveUrl = `/api/image/custom/${params.mediaItemId}/${params.artworkType}`;
                await tx`
                    UPDATE media_items
                    SET ${tx(urlCol)} = ${serveUrl}
                    WHERE id = ${params.mediaItemId}
                      AND ${tx(urlCol)} IS NULL
                `;
            }

            if (provider === 'frame-extract' && params.artworkType === 'backdrop') {
                await tx`SELECT register_image_candidate(id, 'thumb', 'frame-extract', ${providerRef},
                    ${params.filePath}, ${params.sourceTag ?? null}, ${language}) FROM media_items
                    WHERE id = ${params.mediaItemId} AND media_type = 'episode'`;
            }

            // Measuring the first witness of an existing enrichment file changes
            // storage metadata, not its ownership. Known hash changes and explicit
            // writers still clear stale credit through the normal replacement path.
            if (
                (verdict.inserted !== null || upgraded?.count) &&
                params.sourceTag !== 'album-enrichment' &&
                !verdict.hash_backfill_only
            ) {
                await clearMusicArtworkProvenance(tx, params.mediaItemId, params.artworkType);
            }

            // NULL — the statement declined to write, and it was not the tombstone.
            if (verdict.inserted === null)
                return upgraded?.count || consolidated.count ? 'updated' : 'unchanged';
            return verdict.inserted ? 'inserted' : 'updated';
        };
        const outcome = await register();
        if (isAdminWrite && outcome !== 'suppressed') {
            // Explicit curation must not depend on automatic election: bounded
            // episode elections deliberately leave all curated candidates intact.
            const [candidate] = await tx<{ id: string }[]>`SELECT id FROM image_candidates
                WHERE media_item_id=${params.mediaItemId} AND artwork_type=${params.artworkType}
                  AND provider=${provider} AND provider_ref=${providerRef} AND COALESCE(language,'')=''`;
            if (candidate)
                await selectImageCandidate(tx, params.mediaItemId, candidate.id, true, true);
        }
        if (selection.length) {
            const selectedIds = selection.filter((row) => row.selected).map((row) => row.id);
            await tx`UPDATE image_candidates SET selected=false
                WHERE media_item_id=${params.mediaItemId} AND artwork_type=${params.artworkType}
                  AND selected AND NOT(id=ANY(${selectedIds}::uuid[]))`;
            await tx`UPDATE image_candidates c SET selected=prior.selected,selection_order=prior.selection_order
                FROM jsonb_to_recordset(${tx.json(selection)}::jsonb) AS prior(id uuid,selected boolean,selection_order int)
                WHERE c.id=prior.id AND (c.selected IS DISTINCT FROM prior.selected OR c.selection_order IS DISTINCT FROM prior.selection_order)`;
        }
        return outcome;
    });
}

/**
 * Get all artwork for a media item, ordered by sort_order.
 */
export async function getArtworkForMediaItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<MediaArtworkRow[]> {
    return sql<MediaArtworkRow[]>`
        SELECT id, media_item_id, artwork_type, source, file_path,
               remote_url, language, sort_order, created_at
        FROM image_candidates
        WHERE media_item_id = ${mediaItemId} AND NOT suppressed
        ORDER BY sort_order, artwork_type
    `;
}

/**
 * Get the local artwork row for a specific media item and artwork type.
 * Returns null if no local artwork exists.
 */
export async function getLocalArtwork(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
): Promise<MediaArtworkRow | null> {
    // Walk up parent_id chain so child items (tracks,
    // episodes) inherit artwork from their parent.
    //
    // Except an artist's poster: that is a photo of the artist, not a cover.
    // A track or album without art of its own would otherwise show its album
    // artist's photo as its cover, and on a compilation that is the one
    // "Various Artists" image for every track of every compilation.
    const rows = await sql<MediaArtworkRow[]>`
        WITH RECURSIVE ancestors(id, depth) AS (
            SELECT ${mediaItemId}::uuid, 0
            UNION ALL
            SELECT mi.parent_id, a.depth + 1
            FROM ancestors a
            JOIN media_items mi ON mi.id = a.id
            WHERE a.depth < 3
              AND mi.parent_id IS NOT NULL
        )
        SELECT ma.id, ma.media_item_id, ma.artwork_type, ma.source, ma.file_path,
               ma.remote_url, ma.language, ma.sort_order, ma.created_at
        FROM ancestors a
        JOIN image_candidates ma ON ma.media_item_id = a.id
        WHERE ma.artwork_type = ${artworkType}
          AND ma.source = 'local' AND ma.selected AND NOT ma.suppressed
          AND NOT (
              a.depth > 0
              AND ma.artwork_type = 'poster'
              AND EXISTS (
                  SELECT 1 FROM media_items anc
                  WHERE anc.id = a.id AND anc.media_type = 'artist'
              )
          )
        ORDER BY a.depth ASC, ma.selection_order, ma.sort_order, ma.created_at
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Get ONLY this item's own local artwork row for a type — no ancestor walk.
 *
 * Unlike {@link getLocalArtwork} (which inherits up the parent chain so a child
 * resolves its ancestor's image for SERVING), this returns null when the item
 * has no artwork of its own. Use it for mutations that must act on the item's
 * OWN artwork — deleting must never remove an ancestor's row (which would wipe
 * the artwork for the ancestor and every sibling).
 */
export async function getOwnLocalArtwork(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
): Promise<MediaArtworkRow | null> {
    const rows = await sql<MediaArtworkRow[]>`
        SELECT id, media_item_id, artwork_type, source, file_path,
               remote_url, language, sort_order, created_at
        FROM image_candidates
        WHERE media_item_id = ${mediaItemId}
          AND artwork_type = ${artworkType}
          AND source = 'local' AND selected AND NOT suppressed
        ORDER BY selection_order, sort_order
        LIMIT 1
    `;
    return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Artwork suppressions (tombstones) — durable "Remove" for library sidecars
// ---------------------------------------------------------------------------

/**
 * Record that a specific sidecar artwork file was removed, so a later scan does
 * not re-register it. Idempotent.
 */
export async function addArtworkSuppression(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
    filePath: string,
): Promise<void> {
    await sql`
        INSERT INTO media_artwork_suppressions (media_item_id, artwork_type, file_path)
        VALUES (${mediaItemId}, ${artworkType}, ${suppressionKeyPath(filePath)})
        ON CONFLICT (media_item_id, artwork_type, file_path) DO NOTHING
    `;
}

/**
 * Lift the suppression for one exact (item, type, file_path). Called when an
 * admin explicitly (re)uploads artwork to that same path — an intentional
 * override of a prior removal. Suppressions on OTHER paths are left intact.
 */
export async function clearArtworkSuppression(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
    filePath: string,
): Promise<void> {
    await sql`
        DELETE FROM media_artwork_suppressions
        WHERE media_item_id = ${mediaItemId}
          AND artwork_type = ${artworkType}
          AND file_path = ${suppressionKeyPath(filePath)}
    `;
}

/** True when this exact (item, type, file_path) has been removed (tombstoned). */
export async function isArtworkSuppressed(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
    filePath: string,
): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
        FROM media_artwork_suppressions
        WHERE media_item_id = ${mediaItemId}
          AND artwork_type = ${artworkType}
          AND file_path = ${suppressionKeyPath(filePath)}
        LIMIT 1
    `;
    return rows.length > 0;
}

/**
 * True when ANY file has been tombstoned for this (item, type) pair.
 *
 * {@link isArtworkSuppressed} is keyed on (item, type, file_path), which answers
 * "may I re-register THIS exact sidecar?" — the right question for the scanner.
 * It is the WRONG question for a fresh materialization, which is choosing its own
 * filename: a tombstone on `folder.jpg` would not stop a write to `poster.jpg`, so
 * an admin-removed poster would silently come back on every backfill sweep.
 *
 * Checked before any bandwidth is spent, so a suppressed item costs one indexed
 * lookup instead of a CDN fetch plus a disk write. No new index is needed: the
 * table's PRIMARY KEY is (media_item_id, artwork_type, file_path)
 * (migration 16.161.0), and this is a leading-column prefix scan on it.
 */
export async function hasArtworkSuppressionForType(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
        FROM media_artwork_suppressions
        WHERE media_item_id = ${mediaItemId}
          AND artwork_type = ${artworkType}
        LIMIT 1
    `;
    return rows.length > 0;
}

/** A managed artwork row that already claims a given file, on some other item. */
export interface ManagedArtworkClaim {
    media_item_id: string;
    artwork_type: ArtworkType;
}

/**
 * Find a MANAGED artwork row on a DIFFERENT media item that already claims this
 * exact file.
 *
 * Guards the library scanner against re-attributing a file this application
 * wrote. In a season-folderless layout `Show/poster.jpg` (the SERIES poster)
 * resolves via findParentMediaItemByFolder (media-files.queries.ts:721) to an
 * episode, and findSeasonParentIfEpisode (:877) then redirects to season 1 — whose
 * artwork row would be silently re-pointed at the series' image.
 *
 * The `media_item_id <> excludeMediaItemId` scoping is mandatory, not defensive:
 * without it the legitimate re-registration of `Show/Season 01/poster.jpg` onto the
 * season that already claims it would be reported as skipped and under-count every
 * scan.
 *
 * "Managed" is the prefix half of `isManagedArtworkFile`
 * (media-image-storage.service.ts:79-89). Its central-directory fallback is not
 * reproduced here because `<BASE_PATH>/.metadata/` is not inside any library root,
 * so the scanner never walks it.
 *
 * Needs `idx_media_artwork_file_path` — this runs once per artwork file per scan.
 */
export async function findManagedArtworkClaimForPath(
    sql: postgres.Sql,
    filePath: string,
    excludeMediaItemId: string,
): Promise<ManagedArtworkClaim | null> {
    const rows = await sql<ManagedArtworkClaim[]>`
        SELECT media_item_id, artwork_type
        FROM image_candidates
        WHERE file_path = ${filePath}
          AND media_item_id <> ${excludeMediaItemId}
          AND (
              remote_url LIKE 'admin:%'
              OR remote_url LIKE 'provider:%'
              OR remote_url LIKE 'generated:%'
          )
        LIMIT 1
    `;
    return rows[0] ?? null;
}

export interface InheritedArtworkBatchRow {
    /** The requested media item this row resolves FOR (not where the file lives). */
    origin_id: string;
    artwork_type: ArtworkType;
    file_path: string | null;
    /** 0 = own artwork, 1+ = inherited from an ancestor (season/series). */
    depth: number;
}

/**
 * Batched variant of {@link getLocalArtwork} for many sibling items at once
 * (e.g. every episode of a season). Returns ALL matching local artwork rows
 * along the parent chain, ordered so that per (origin_id, artwork_type) the
 * FIRST row is the one getLocalArtwork would have picked (nearest ancestor).
 * Used to warm the image proxy's L1 cache in one round-trip instead of one
 * recursive CTE per item per type.
 */
export async function getLocalArtworkInheritedBatch(
    sql: postgres.Sql,
    mediaItemIds: string[],
    artworkTypes: ArtworkType[],
): Promise<InheritedArtworkBatchRow[]> {
    if (mediaItemIds.length === 0 || artworkTypes.length === 0) return [];
    return sql<InheritedArtworkBatchRow[]>`
        WITH RECURSIVE ancestors(origin_id, id, depth) AS (
            SELECT mi.id, mi.id, 0
            FROM media_items mi
            WHERE mi.id = ANY(${mediaItemIds}::uuid[])
            UNION ALL
            SELECT a.origin_id, mi.parent_id, a.depth + 1
            FROM ancestors a
            JOIN media_items mi ON mi.id = a.id
            WHERE a.depth < 3
              AND mi.parent_id IS NOT NULL
        )
        SELECT a.origin_id, ma.artwork_type, ma.file_path, a.depth
        FROM ancestors a
        JOIN image_candidates ma
            ON ma.media_item_id = a.id
           AND ma.source = 'local' AND ma.selected AND NOT ma.suppressed
           AND ma.artwork_type = ANY(${artworkTypes}::text[])
        ORDER BY a.origin_id, ma.artwork_type, a.depth ASC, ma.selection_order, ma.sort_order, ma.created_at
    `;
}

/**
 * Per-episode "can a thumb request serve an episode-specific image?" — the
 * client skips the request entirely when false, so this counts every STORED
 * source that yields something better than the series backdrop:
 *  - own local artwork (extracted frame, stored as thumb or backdrop) — the
 *    primary source; images are served from local storage
 *  - SEASON-level local artwork (inherits ahead of the series backdrop)
 *  - custom_thumb_url
 *  - a stored provider still (`still_path` / neutral `artwork.still`), which is
 *    what the reconciliation / still-by-match pipeline persists for the exact
 *    matched TMDB episode
 *
 * Deliberately NOT counted:
 *  - jellyfin external ids — Jellyfin is a watch-sync integration only; it is
 *    not in the image-serve path here, and a jellyfin id is stamped on nearly
 *    every synced episode, so counting it would flip ~everything to true and
 *    defeat the skip entirely.
 *  - a bare tmdb id — the TMDB episode-still path (getEpisodeStillPath) does
 *    NOT key off the episode's own tmdb id; it resolves via the SERIES tmdb id
 *    plus the episode's local season/episode NUMBER, a live API call the code
 *    itself flags as returning the WRONG episode when local numbering diverges
 *    from TMDB. The reliable TMDB stills are exactly the ones persisted as
 *    `still_path` above; an unmatched episode with no stored still is better
 *    served the neutral series backdrop than a possibly-wrong live guess.
 *
 * False therefore means: no stored episode/season-specific image exists — the
 * request could only echo the series backdrop. Episodes whose still is TMDB-
 * fetchable but not yet persisted flip to true once the still backfill runs.
 */
export async function getOwnStillPresence(
    sql: postgres.Sql,
    mediaItemIds: string[],
): Promise<Map<string, boolean>> {
    if (mediaItemIds.length === 0) return new Map();
    const rows = await sql<{ id: string; has_own_still: boolean }[]>`
        SELECT
            mi.id,
            (
                mi.custom_thumb_url IS NOT NULL
                OR EXISTS (
                    SELECT 1 FROM image_candidates ma
                    WHERE ma.media_item_id = mi.id
                      AND ma.source = 'local' AND ma.selected AND NOT ma.suppressed
                      AND ma.artwork_type IN ('thumb', 'backdrop')
                )
                OR (
                    mi.parent_id IS NOT NULL
                    AND EXISTS (
                        SELECT 1 FROM image_candidates ma
                        WHERE ma.media_item_id = mi.parent_id
                          AND ma.source = 'local' AND ma.selected AND NOT ma.suppressed
                          AND ma.artwork_type IN ('thumb', 'backdrop')
                    )
                )
                OR EXISTS (
                    SELECT 1 FROM provider_metadata pm
                    WHERE pm.media_id = mi.id
                      AND COALESCE(
                              pm.metadata->>'still_path',
                              pm.metadata->'artwork'->>'still'
                          ) IS NOT NULL
                )
            ) AS has_own_still
        FROM media_items mi
        WHERE mi.id = ANY(${mediaItemIds}::uuid[])
    `;
    return new Map(rows.map((r) => [r.id, r.has_own_still]));
}

/**
 * Delete all local artwork for a media item (used when re-scanning a removed folder).
 *
 * Symmetric counterpart to `upsertLocalArtwork`: clears the paired
 * `custom_{type}_url` columns, but only when they still point to our own
 * proxy endpoint (i.e., were set by the invariant). User-uploaded or
 * provider URLs (TMDB/Jellyfin) are preserved untouched.
 */
export async function deleteLocalArtworkForItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<void> {
    const proxyPrefix = `/api/image/custom/${mediaItemId}/`;
    const proxyLike = `${proxyPrefix}%`;
    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await lockArtworkOwners(tx, [mediaItemId]);
        await tx`
            DELETE FROM image_candidates
            WHERE media_item_id = ${mediaItemId} AND source = 'local'
        `;
        await tx`
            UPDATE media_items
            SET custom_poster_url   = CASE WHEN custom_poster_url   LIKE ${proxyLike} THEN NULL ELSE custom_poster_url   END,
                custom_backdrop_url = CASE WHEN custom_backdrop_url LIKE ${proxyLike} THEN NULL ELSE custom_backdrop_url END,
                custom_logo_url     = CASE WHEN custom_logo_url     LIKE ${proxyLike} THEN NULL ELSE custom_logo_url     END,
                custom_thumb_url    = CASE WHEN custom_thumb_url    LIKE ${proxyLike} THEN NULL ELSE custom_thumb_url    END
            WHERE id = ${mediaItemId}
        `;
    });
}

/**
 * Delete a single artwork row by its primary key.
 *
 * When the deleted row is a `local` row, clears the paired
 * `custom_{type}_url` column if it still points to our proxy endpoint.
 */
export async function deleteArtworkById(sql: postgres.Sql, id: string): Promise<boolean> {
    return deleteArtworkMatching(sql, id);
}

/** Delete only the still-automatic local candidate observed before a filesystem await. */
export interface ObservedArtwork {
    id: string;
    media_item_id: string;
    file_path: string;
    version: string;
    provider: string;
    provider_ref: string;
    remote_url: string | null;
}

export async function deleteMissingArtwork(
    sql: postgres.Sql,
    observed: ObservedArtwork,
): Promise<boolean> {
    return deleteArtworkMatching(sql, observed.id, observed);
}

async function deleteArtworkMatching(
    sql: postgres.Sql,
    id: string,
    observed?: ObservedArtwork,
): Promise<boolean> {
    return await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const [owner] = await tx<{ media_item_id: string }[]>`
            SELECT media_item_id FROM image_candidates WHERE id = ${id}
        `;
        if (!owner) return false;
        await lockArtworkOwners(tx, [owner.media_item_id]);
        const rows = await tx<
            {
                media_item_id: string;
                artwork_type: ArtworkType;
                source: ArtworkSource;
            }[]
        >`
            DELETE FROM image_candidates
            WHERE id = ${id} AND media_item_id = ${owner.media_item_id}
              AND (${observed === undefined} OR (
                  media_item_id = ${observed?.media_item_id ?? null}::uuid
                  AND file_path = ${observed?.file_path ?? null}
                  AND source = 'local' AND NOT locked AND chosen_by = 'auto'
                  AND updated_at::text = ${observed?.version ?? null}
                  AND provider = ${observed?.provider ?? null} AND provider_ref = ${observed?.provider_ref ?? null}
                  AND remote_url IS NOT DISTINCT FROM ${observed?.remote_url ?? null}))
            RETURNING media_item_id, artwork_type, source
        `;
        const row = rows[0];
        if (!row) return false;

        if (row.source === 'local') {
            const urlCol = ARTWORK_URL_COLUMN[row.artwork_type];
            if (urlCol) {
                const proxyUrl = `/api/image/custom/${row.media_item_id}/${row.artwork_type}`;
                await tx`
                    UPDATE media_items
                    SET ${tx(urlCol)} = NULL
                    WHERE id = ${row.media_item_id}
                      AND ${tx(urlCol)} = ${proxyUrl}
                      AND NOT EXISTS (SELECT 1 FROM image_candidates
                          WHERE media_item_id = ${row.media_item_id} AND artwork_type = ${row.artwork_type}
                            AND selected AND source = 'local' AND file_path IS NOT NULL)
                `;
            }
        }
        return true;
    });
}

export interface EnrichedArtworkItem {
    id: string;
    artworkType: ArtworkType;
    url: string;
    source: 'self' | 'season' | 'series' | 'album' | 'artist';
    sourceId: string;
    sourceName: string;
}

interface AncestorRow {
    id: string;
    title: string | null;
    media_type: string;
    depth: number;
}

/**
 * Return artwork for a media item with inheritance information.
 * For each slot (poster, backdrop, logo, thumb), walks the parent chain
 * (episode → season → series) and returns where the image actually lives.
 * Only considers locally-stored artwork (source = 'local' in image_candidates).
 */
export async function getArtworkWithInheritance(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<EnrichedArtworkItem[]> {
    const chain = await sql<AncestorRow[]>`
        WITH RECURSIVE ancestors AS (
            SELECT id, title, parent_id, media_type, 0 AS depth
            FROM media_items
            WHERE id = ${mediaItemId}
            UNION ALL
            SELECT m.id, m.title, m.parent_id, m.media_type, a.depth + 1
            FROM media_items m
            JOIN ancestors a ON m.id = a.parent_id
            -- depth < 3 matches getLocalArtwork's serve-side walk so the editor's
            -- inheritance view can never disagree with what actually gets served.
            WHERE a.depth < 3
        )
        SELECT id, title, media_type, depth
        FROM ancestors
        ORDER BY depth
    `;
    if (chain.length === 0) return [];

    const allIds = chain.map((a) => a.id);
    const allArtwork = await sql<MediaArtworkRow[]>`
        SELECT id, media_item_id, artwork_type, source, file_path,
               remote_url, language, sort_order, created_at
        FROM image_candidates
        WHERE media_item_id = ANY(${allIds})
          AND source = 'local' AND selected AND NOT suppressed
        ORDER BY sort_order, created_at
    `;

    // Build lookup: mediaItemId → artworkType → first row
    const artworkByItem = new Map<string, Map<ArtworkType, MediaArtworkRow>>();
    for (const row of allArtwork) {
        let byType = artworkByItem.get(row.media_item_id);
        if (!byType) {
            byType = new Map();
            artworkByItem.set(row.media_item_id, byType);
        }
        if (!byType.has(row.artwork_type)) {
            byType.set(row.artwork_type, row);
        }
    }

    const currentItem = chain[0];
    const ancestors = chain.slice(1);
    const ARTWORK_TYPES: ArtworkType[] = ['poster', 'backdrop', 'logo', 'thumb'];
    const result: EnrichedArtworkItem[] = [];

    for (const artworkType of ARTWORK_TYPES) {
        const selfArt = artworkByItem.get(mediaItemId)?.get(artworkType);
        if (selfArt) {
            result.push({
                id: selfArt.id,
                artworkType,
                url: `/api/image/catalog/${mediaItemId}/${artworkType}`,
                source: 'self',
                sourceId: mediaItemId,
                sourceName: currentItem.title ?? mediaItemId,
            });
            continue;
        }

        // Walk ancestors, nearest first. An artist's poster is never inherited
        // (see getLocalArtwork), so the editor does not show one either.
        for (const ancestor of ancestors) {
            if (artworkType === 'poster' && ancestor.media_type === 'artist') continue;
            const inherited = artworkByItem.get(ancestor.id)?.get(artworkType);
            if (inherited) {
                // Label the inheritance level by the ancestor's actual type so the
                // music hierarchy (track→album→artist) isn't mislabeled "Series".
                // media_items.media_type is stored lowercase.
                const sourceLevel: 'season' | 'series' | 'album' | 'artist' = isSeason(
                    ancestor.media_type,
                )
                    ? 'season'
                    : ancestor.media_type === 'album'
                      ? 'album'
                      : ancestor.media_type === 'artist'
                        ? 'artist'
                        : 'series';
                result.push({
                    id: inherited.id,
                    artworkType,
                    // fallback=none so a genuinely-missing inherited image 404s (the
                    // editor then shows the add-image controls) instead of 302-ing to
                    // the popcorn placeholder rendered under an "INHERITED" badge.
                    url: `/api/image/catalog/${ancestor.id}/${artworkType}?fallback=none`,
                    source: sourceLevel,
                    sourceId: ancestor.id,
                    sourceName: ancestor.title ?? ancestor.id,
                });
                break;
            }
        }
        // No artwork at any level → slot omitted from result
    }

    return result;
}

export interface SharedEpisodeThumbReviewRow {
    episodeId: string;
    episodeTitle: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    selectedCandidateId: string;
    artworkPath: string;
    sharedCount: number;
    candidateCount: number;
    chosenBy: string;
    locked: boolean;
    provider: string;
    suppressed: boolean;
    sourceFileId: string | null;
    sourcePath: string | null;
    sourceMissing: boolean | null;
    sourceDurationSeconds: number | null;
    sourceSharedCount: number;
    startOffsetMs: string | null;
    endOffsetMs: string | null;
}

/** Bounded admin projection; a shared path is evidence for review, not ownership. */
export async function listSharedEpisodeThumbReview(
    sql: postgres.Sql,
    scopeId: string,
    limit: number,
    offset: number,
): Promise<{ total: number; rows: SharedEpisodeThumbReviewRow[] }> {
    const [count] = await sql<{ total: number }[]>`
        WITH selected AS (
            SELECT ep.id, c.file_path, season.id AS season_id, season.parent_id AS series_id
            FROM media_items ep
            JOIN media_items season ON season.id=ep.parent_id AND season.media_type='season'
            JOIN image_candidates c ON c.media_item_id=ep.id AND c.artwork_type='thumb' AND c.selected
            WHERE ep.media_type='episode' AND ep.status<>'deleted'
              AND c.file_path IS NOT NULL AND c.file_path<>''
        ), shared AS (SELECT file_path FROM selected GROUP BY file_path HAVING count(*)>1)
        SELECT count(*)::int AS total FROM selected JOIN shared USING(file_path)
        WHERE selected.season_id=${scopeId} OR selected.series_id=${scopeId}`;
    const rows = await sql<SharedEpisodeThumbReviewRow[]>`
        WITH selected AS (
            SELECT ep.id, ep.title, ep.parent_id, ep.episode_number, season.season_number,
                season.id AS season_id, season.parent_id AS series_id,
                c.id AS candidate_id, c.file_path, c.chosen_by, c.locked, c.provider
            FROM media_items ep
            JOIN media_items season ON season.id=ep.parent_id AND season.media_type='season'
            JOIN image_candidates c ON c.media_item_id=ep.id AND c.artwork_type='thumb' AND c.selected
            WHERE ep.media_type='episode' AND ep.status<>'deleted'
              AND c.file_path IS NOT NULL AND c.file_path<>''
        ), shared AS (
            SELECT file_path, count(*)::int AS n FROM selected GROUP BY file_path HAVING count(*)>1
        )
        SELECT ep.id AS "episodeId", ep.title AS "episodeTitle",
            ep.season_number AS "seasonNumber", ep.episode_number AS "episodeNumber",
            ep.candidate_id AS "selectedCandidateId", ep.file_path AS "artworkPath",
            shared.n AS "sharedCount", ep.chosen_by AS "chosenBy", ep.locked, ep.provider,
            (SELECT count(*)::int FROM image_candidates c
             WHERE c.media_item_id=ep.id AND c.artwork_type='thumb') AS "candidateCount",
            EXISTS(SELECT 1 FROM media_artwork_suppressions s
                WHERE s.media_item_id=ep.id AND s.artwork_type='thumb') AS suppressed,
            mf.id AS "sourceFileId", mf.file_path AS "sourcePath", mf.is_missing AS "sourceMissing",
            mf.duration_seconds AS "sourceDurationSeconds",
            (SELECT count(*)::int FROM media_file_items other
                JOIN media_items other_ep ON other_ep.id=other.media_item_id AND other_ep.media_type='episode'
                WHERE other.file_id=mf.id AND other.is_default) AS "sourceSharedCount",
            mfi.start_offset_ms::text AS "startOffsetMs", mfi.end_offset_ms::text AS "endOffsetMs"
        FROM selected ep JOIN shared ON shared.file_path=ep.file_path
        LEFT JOIN media_file_items mfi ON mfi.media_item_id=ep.id AND mfi.is_default
        LEFT JOIN media_files mf ON mf.id=mfi.file_id
        WHERE ep.season_id=${scopeId} OR ep.series_id=${scopeId}
        ORDER BY ep.season_number NULLS LAST, ep.episode_number NULLS LAST, ep.id
        LIMIT ${limit} OFFSET ${offset}`;
    return { total: count?.total ?? 0, rows };
}

/** One episode inside a duplicate-thumbnail group, with what it needs to be classified. */
export interface DuplicateThumbEpisode {
    seriesId: string;
    episodeId: string;
    /** Default media_files.id. Episodes sharing one file legitimately share a thumb. */
    fileId: string | null;
    /** Default media_files.file_path — the basis for the expected artwork filename. */
    videoPath: string | null;
    /** The thumbnail path currently recorded for this episode. */
    artworkPath: string;
}

/**
 * Episodes inside duplicate-thumbnail groups, for the next `seriesLimit` series
 * after `afterSeriesId` (keyset pagination on series id).
 *
 * A series-level check answers "which series look
 * broken", which is not the same question as "which series can a re-scan
 * actually fix". A season whose episodes have no thumbnail file on disk at all
 * matches the fingerprint forever: re-scanning finds nothing to map, the rows
 * never change, and the repair task re-enqueues it every cycle. On prod that
 * was 1,896 of 2,311 duplicate rows — 82% of the residual backlog was
 * structurally unfixable by scanning and being retried twice an hour anyway.
 *
 * Deciding that requires the filesystem, which SQL cannot see, so this returns
 * the inputs and lets the caller check. Pagination matters: the caller skips
 * unfixable series, and without a cursor the deterministic `ORDER BY series_id`
 * would hand back the same unfixable prefix every cycle and starve the fixable
 * series behind it.
 */
export async function findDuplicateThumbEpisodes(
    sql: postgres.Sql,
    afterSeriesId: string | null,
    seriesLimit: number,
): Promise<DuplicateThumbEpisode[]> {
    return sql<DuplicateThumbEpisode[]>`
        WITH dupe AS (
            SELECT ep.parent_id AS season_id, ma.file_path
            FROM media_items ep
            JOIN image_candidates ma
                ON ma.media_item_id = ep.id AND ma.artwork_type = 'thumb' AND ma.selected
            WHERE ep.media_type = 'episode' AND ma.file_path IS NOT NULL AND ma.file_path <> ''
            GROUP BY ep.parent_id, ma.file_path
            HAVING count(*) > 1
        ),
        affected AS (
            SELECT DISTINCT s.parent_id AS series_id
            FROM dupe d
            JOIN media_items s ON s.id = d.season_id
            WHERE s.parent_id IS NOT NULL
              AND (${afterSeriesId}::uuid IS NULL OR s.parent_id > ${afterSeriesId}::uuid)
            ORDER BY series_id
            LIMIT ${seriesLimit}
        )
        SELECT
            a.series_id   AS "seriesId",
            ep.id         AS "episodeId",
            mf.id         AS "fileId",
            mf.file_path  AS "videoPath",
            ma.file_path  AS "artworkPath"
        FROM affected a
        JOIN media_items s   ON s.parent_id = a.series_id
        JOIN media_items ep  ON ep.parent_id = s.id AND ep.media_type = 'episode'
        JOIN image_candidates ma
            ON ma.media_item_id = ep.id AND ma.artwork_type = 'thumb' AND ma.selected
        JOIN dupe d ON d.season_id = ep.parent_id AND d.file_path = ma.file_path
        LEFT JOIN media_file_items mfi ON mfi.media_item_id = ep.id AND mfi.is_default = true
        LEFT JOIN media_files mf ON mf.id = mfi.file_id
        ORDER BY a.series_id, ep.id
    `;
}

/**
 * An episode whose thumbnail looks wrong: either it has no local thumb row at
 * all, or its row shares a file_path with a sibling. Whether that is fixable by
 * a database remap or needs a frame decoded is decided by
 * `classifyEpisodeThumbnail` — SQL cannot see the filesystem.
 */
export interface EpisodeThumbnailWorkRow {
    episodeId: string;
    seasonId: string | null;
    /** Default media_files.id — combined episodes may have separate bounded frames. */
    fileId: string | null;
    videoPath: string;
    durationSeconds: number;
    /** Currently recorded thumbnail path, or null when the episode has none. */
    artworkPath: string | null;
    /** Start offset inside a combined multi-episode file, ms. */
    startOffsetMs: string | null;
    /** End offset inside a combined multi-episode file, ms. */
    endOffsetMs: string | null;
}

/**
 * Precomputed exclusion sets for {@link findEpisodeThumbnailWork} — see that
 * function's `exclusions` parameter for why these are hoisted out.
 */
export interface EpisodeThumbnailExclusions {
    /** (season_id, file_path) pairs that more than one episode's thumb shares. */
    shared: { seasonId: string; filePath: string }[];
}

/**
 * Compute shared-thumbnail paths once per run, rather than once per page.
 * Combined files are intentionally not excluded: sharing a video says nothing
 * about whether the selected sidecar belongs to that video. The classifier
 * verifies the actual sidecar name before deciding to remap or regenerate.
 */
export async function loadEpisodeThumbnailExclusions(
    sql: postgres.Sql,
): Promise<EpisodeThumbnailExclusions> {
    const sharedRows = await sql<{ season_id: string; file_path: string }[]>`
            SELECT ep.parent_id AS season_id, ma.file_path
            FROM media_items ep
            JOIN image_candidates ma
                ON ma.media_item_id = ep.id AND ma.artwork_type = 'thumb' AND ma.selected
            WHERE ep.media_type = 'episode' AND ma.file_path IS NOT NULL AND ma.file_path <> ''
            GROUP BY ep.parent_id, ma.file_path
            HAVING count(*) > 1
        `;
    return {
        shared: sharedRows.map((r) => ({ seasonId: r.season_id, filePath: r.file_path })),
    };
}

/**
 * Episodes whose thumbnail is missing or shared with a sibling, paged by id.
 *
 * The SINGLE candidate query for episode-thumbnail work. Both the remap
 * strategy and the generation strategy consult it and then classify the rows
 * via `classifyEpisodeThumbnail`, so the two can no longer disagree about which
 * episodes are broken — that disagreement is what let ~18,000 episodes fall
 * between three tasks.
 *
 * Requires a default file with a known duration — without a duration there is no
 * window to sample, and `media-probe` fills that in on its own schedule. Do NOT
 * ffprobe here; that is the round-trip PR-0 removed.
 *
 * Offsets are bigint columns and come back from postgres.js as STRINGS; the
 * caller converts. Returning them raw keeps the numeric coercion in one place.
 *
 * `exclusions`: pass a value from {@link loadEpisodeThumbnailExclusions} when
 * paging through this in a loop, so the two whole-catalog aggregates it
 * replaces are computed once per task run instead of once per page (prod
 * slow-query log, 2026-09-26: 32 calls/4.3h, p50 288ms, up to ~730ms under
 * cold cache — the per-page CTE recomputation was the majority of that).
 * Omit it for a one-off call (e.g. an ad-hoc admin probe or a test) — the
 * original inline CTEs still run, unchanged.
 */
export async function findEpisodeThumbnailWork(
    sql: postgres.Sql,
    afterEpisodeId: string | null,
    limit: number,
    exclusions?: EpisodeThumbnailExclusions,
    scopeId?: string,
): Promise<EpisodeThumbnailWorkRow[]> {
    if (exclusions) {
        return sql<EpisodeThumbnailWorkRow[]>`
            WITH shared(season_id, file_path) AS (
                SELECT * FROM unnest(
                    ${sql.array(exclusions.shared.map((s) => s.seasonId))}::uuid[],
                    ${sql.array(exclusions.shared.map((s) => s.filePath))}::text[]
                ) AS t(season_id, file_path)
            )
            SELECT
                ep.id                    AS "episodeId",
                ep.parent_id             AS "seasonId",
                mf.id                    AS "fileId",
                mf.file_path             AS "videoPath",
                mf.duration_seconds      AS "durationSeconds",
                ma.file_path             AS "artworkPath",
                mfi.start_offset_ms::text AS "startOffsetMs",
                mfi.end_offset_ms::text   AS "endOffsetMs"
            FROM media_items ep
            LEFT JOIN media_items scope_season ON scope_season.id=ep.parent_id
            JOIN media_file_items mfi ON mfi.media_item_id = ep.id AND mfi.is_default = true
            JOIN media_files mf ON mf.id = mfi.file_id
            LEFT JOIN image_candidates ma
                ON ma.media_item_id = ep.id AND ma.artwork_type = 'thumb' AND ma.source = 'local' AND ma.selected AND NOT ma.suppressed
            LEFT JOIN shared s ON s.season_id = ep.parent_id AND s.file_path = ma.file_path
            WHERE ep.media_type = 'episode'
              AND (${scopeId ?? null}::uuid IS NULL OR ep.id=${scopeId ?? null}::uuid
                OR ep.parent_id=${scopeId ?? null}::uuid OR scope_season.parent_id=${scopeId ?? null}::uuid)
              AND mf.file_path IS NOT NULL
              AND mf.duration_seconds IS NOT NULL
              AND mf.duration_seconds > 0
              AND (ma.media_item_id IS NULL OR s.file_path IS NOT NULL)
              AND (${afterEpisodeId}::uuid IS NULL OR ep.id > ${afterEpisodeId}::uuid)
            ORDER BY ep.id
            LIMIT ${limit}
        `;
    }
    return sql<EpisodeThumbnailWorkRow[]>`
        WITH shared AS (
            SELECT ep.parent_id AS season_id, ma.file_path
            FROM media_items ep
            LEFT JOIN media_items scope_season ON scope_season.id=ep.parent_id
            JOIN image_candidates ma
                ON ma.media_item_id = ep.id AND ma.artwork_type = 'thumb' AND ma.selected
            WHERE ep.media_type = 'episode' AND ma.file_path IS NOT NULL AND ma.file_path <> ''
            GROUP BY ep.parent_id, ma.file_path
            HAVING count(*) > 1
        )
        SELECT
            ep.id                    AS "episodeId",
            ep.parent_id             AS "seasonId",
            mf.id                    AS "fileId",
            mf.file_path             AS "videoPath",
            mf.duration_seconds      AS "durationSeconds",
            ma.file_path             AS "artworkPath",
            mfi.start_offset_ms::text AS "startOffsetMs",
            mfi.end_offset_ms::text   AS "endOffsetMs"
        FROM media_items ep
            LEFT JOIN media_items scope_season ON scope_season.id=ep.parent_id
        JOIN media_file_items mfi ON mfi.media_item_id = ep.id AND mfi.is_default = true
        JOIN media_files mf ON mf.id = mfi.file_id
        LEFT JOIN image_candidates ma
            ON ma.media_item_id = ep.id AND ma.artwork_type = 'thumb' AND ma.source = 'local' AND ma.selected AND NOT ma.suppressed
        LEFT JOIN shared s ON s.season_id = ep.parent_id AND s.file_path = ma.file_path
        WHERE ep.media_type = 'episode'
              AND (${scopeId ?? null}::uuid IS NULL OR ep.id=${scopeId ?? null}::uuid
                OR ep.parent_id=${scopeId ?? null}::uuid OR scope_season.parent_id=${scopeId ?? null}::uuid)
          AND mf.file_path IS NOT NULL
          AND mf.duration_seconds IS NOT NULL
          AND mf.duration_seconds > 0
          AND (ma.media_item_id IS NULL OR s.file_path IS NOT NULL)
          AND (${afterEpisodeId}::uuid IS NULL OR ep.id > ${afterEpisodeId}::uuid)
        ORDER BY ep.id
        LIMIT ${limit}
    `;
}

/**
 * Register an episode's own on-disk sidecar without decoding video. Registration
 * preserves existing candidates, manual selections and suppression tombstones,
 * and also works after a foreign reference was removed. Returns 1 when changed.
 */
export async function remapEpisodeThumbnailPath(
    sql: postgres.Sql,
    mediaItemId: string,
    filePath: string,
): Promise<number> {
    return withTx(sql, async (tx) => {
        await lockArtworkOwners(tx, [mediaItemId]);
        const manual = await tx`SELECT 1 FROM image_candidates WHERE media_item_id=${mediaItemId}
            AND artwork_type='thumb' AND selected AND (locked OR chosen_by<>'auto') LIMIT 1`;
        if (manual.length) return 0;
        // Registration also works when the foreign row was already removed.
        // It must never rewrite provider cache paths or candidate identities.
        const outcome = await upsertLocalArtworkWithOutcome(tx, {
            mediaItemId,
            artworkType: 'thumb',
            filePath,
        });
        return outcome === 'inserted' || outcome === 'updated' ? 1 : 0;
    });
}

/** Legacy fallback while committed provenance batches have not reached this owner yet. */
export async function getLegacyLocalArtwork(
    sql: postgres.Sql,
    owner: string,
    role: ArtworkType,
    inherit = true,
): Promise<ImageCandidate | null> {
    const rows = await sql<ImageCandidate[]>`
        WITH RECURSIVE ancestors(id,depth) AS (
            SELECT ${owner}::uuid,0 UNION ALL
            SELECT mi.parent_id,a.depth+1 FROM ancestors a JOIN media_items mi ON mi.id=a.id
            WHERE ${inherit} AND a.depth<3 AND mi.parent_id IS NOT NULL
        )
        SELECT ma.id,ma.media_item_id,NULL::text AS person_ref,ma.artwork_type,
            image_provider(ma.remote_url,ma.file_path) AS provider,
            COALESCE(ma.remote_url,ma.file_path,ma.id::text) AS provider_ref,
            ma.file_path,ma.remote_url,ma.language,ma.sort_order,NULL::integer AS width,NULL::integer AS height,
            'auto'::text AS chosen_by,false AS locked,true AS selected,ma.created_at::text AS fetched_at
        FROM ancestors a JOIN media_artwork ma ON ma.media_item_id=a.id
        JOIN media_items mi ON mi.id=a.id
        WHERE ma.artwork_type=${role} AND ma.source='local' AND ma.file_path IS NOT NULL
            AND NOT (a.depth>0 AND ${role}='poster' AND mi.media_type='artist')
            AND NOT EXISTS (SELECT 1 FROM image_provider_suppressions s WHERE s.owner=ma.media_item_id::text
                AND s.provider IN ('*',image_provider(ma.remote_url,ma.file_path)) AND s.role IN ('*',ma.artwork_type))
            AND NOT EXISTS (SELECT 1 FROM media_artwork_suppressions s WHERE s.media_item_id=ma.media_item_id
                AND s.artwork_type=ma.artwork_type AND s.file_path=ma.file_path)
        ORDER BY a.depth,ma.sort_order,ma.created_at LIMIT 1`;
    return rows[0] ?? null;
}
