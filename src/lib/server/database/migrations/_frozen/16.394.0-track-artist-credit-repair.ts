// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frozen stored-tag artist-credit repair run by migration 16.394.0.
 *
 * FROZEN: do not edit this to follow later changes of the live scanner path
 * (`services/music/artist-credit-ingestion.ts`). A migration's behaviour must
 * not move under an already-recorded checksum. Every database read and write
 * lives here, including copies of the evidence query and of `withSyncReset`;
 * only pure helpers are shared with live code (`resolveArtistCredit`,
 * `buildArtistCreditEvidence`, `extractRemixerCandidates`, `clampTagText`,
 * the Various Artists label).
 *
 * Why not the live per-track `reconcileTrackArtistCredits`: every artist
 * lookup there is one query whose expression no index matched, so at 100k
 * tracks x 10k artists the repair took hours at boot, past the 120 s
 * migration-lock wait of the other migrators and the liveness probes, and one
 * "Ambiguous Unicode artist identity" row threw and failed boot forever.
 *
 * This version:
 * - loads every active top-level artist once and resolves names in memory
 *   (keys computed by PostgreSQL with the identity-index expression
 *   `LOWER(TRIM(normalize(x, NFC)))`, so JS and SQL never disagree);
 * - writes one UPDATE per batch of tracks with change capture off and the
 *   sync epoch bumped in the same transaction (the `withSyncReset` contract),
 *   so the sync feed does not log the whole music library as changed. Each
 *   batch bumps the epoch, so a client that syncs during the repair reloads
 *   more than once; prod gets the sync feed in the same release, so it has no
 *   cursor holders yet;
 * - resumes: a track that already carries `artist_credit_source` was done by
 *   an earlier, interrupted run (or by the scanner) and is skipped;
 * - never throws on one track's data: the track keeps its legacy display,
 *   gets `artist_credit_repair_error`, and the scanner's per-file
 *   `ensureTrackArtistLinks` (every library scan) retries and clears it.
 *   Only a systemic failure (database gone) fails the migration, which the
 *   next boot resumes.
 */

import type postgres from 'postgres';
import {
    buildArtistCreditEvidence,
    resolveArtistCredit,
    type ArtistCreditEvidence,
} from '../../../tasks/builtin/native/media-sources/_helpers/file-scanner/artist-credit.js';
import { clampTagText } from '../../../utils/tag-text.js';
import { extractRemixerCandidates } from '../../../../shared/remix-credit.js';
import { isVariousArtistsName, VARIOUS_ARTISTS_LABEL } from '../../../../shared/various-artists.js';
import { Logger } from '../../../utils/logger.js';

const logger = Logger.for('Migration16_394_ArtistCreditRepair');

/** Frozen copy of `withSyncReset`: capture off, epoch bumped last, one transaction. */
async function withCaptureSuspended<T>(
    sql: postgres.Sql,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
    return (await sql.begin(async (tx) => {
        await tx`SET LOCAL lumastra.sync_capture = 'off'`;
        const result = await fn(tx);
        await tx`UPDATE sync_state SET epoch = epoch + 1 WHERE id = 1`;
        return result;
    })) as T;
}

/** Frozen copy of `listArtistCreditEvidenceSources` (artist-merge.queries.ts, 2026-10-20). */
async function loadEvidence(sql: postgres.Sql): Promise<ArtistCreditEvidence> {
    const tagRows = await sql<{ tag: string }[]>`
        WITH r AS MATERIALIZED (
            SELECT x.artist, x.album_artist, x.artists, x.album_artists
            FROM media_items mi
            CROSS JOIN LATERAL jsonb_to_record(
                CASE WHEN jsonb_typeof(mi.custom_metadata) = 'object'
                     THEN mi.custom_metadata ELSE '{}'::jsonb END
            ) AS x(artist text, album_artist text, artists jsonb, album_artists jsonb)
            WHERE mi.media_type = 'track'
              AND mi.status = 'active'
        )
        SELECT DISTINCT tag FROM (
            SELECT artist AS tag FROM r
            UNION ALL
            SELECT album_artist FROM r
            UNION ALL
            SELECT jsonb_array_elements_text(artists) FROM r
            WHERE jsonb_typeof(artists) = 'array'
            UNION ALL
            SELECT jsonb_array_elements_text(album_artists) FROM r
            WHERE jsonb_typeof(album_artists) = 'array'
        ) s
        WHERE tag IS NOT NULL AND tag <> ''
    `;
    const actRows = await sql<{ title: string }[]>`
        SELECT title FROM media_items
        WHERE media_type = 'artist'
          AND status = 'active'
          AND (
            COALESCE(custom_metadata->>'no_split', '') = 'true'
            OR COALESCE(custom_metadata->>'musicbrainz_artist_id', '') <> ''
          )
    `;
    return buildArtistCreditEvidence(
        tagRows.map((r) => r.tag),
        actRows.map((r) => r.title),
    );
}

/** Tracks per transaction. Each batch holds its row locks for well under a second. */
export const REPAIR_BATCH_SIZE = 500;
/** Batches written at once, each on its own pooled connection. */
export const REPAIR_CONCURRENCY = 4;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FrozenArtistCreditRepairResult {
    scanned: number;
    updated: number;
    failed: number;
    createdArtists: number;
    durationMs: number;
    /** Where the time went: select ids, lock + read, derive, write. */
    phasesMs: { select: number; lock: number; derive: number; write: number };
    errors: { trackId: string; error: string }[];
}

interface TrackRow {
    id: string;
    custom_metadata: Record<string, unknown>;
    library_group_id: string | null;
    title: string;
    metadata_locked: boolean;
}
interface Credit {
    id: string | null;
    credited_name: string;
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value
              .filter((v): v is string => typeof v === 'string')
              .slice(0, 64)
              .map(clampTagText)
              .filter(Boolean)
        : [];
}
function ids(value: unknown): string[] {
    return strings(value).filter((id) => UUID.test(id));
}
function names(
    meta: Record<string, unknown>,
    multi: string,
    single: string,
    evidence: ArtistCreditEvidence,
    key: (name: string) => string,
): string[] {
    const values = strings(meta[multi]);
    if (values.length > 1) {
        const seen = new Set<string>();
        return values
            .map((name) => name.trim())
            .filter((name) => name && !seen.has(key(name)) && Boolean(seen.add(key(name))));
    }
    const scalar =
        values[0] ?? (typeof meta[single] === 'string' ? clampTagText(meta[single]) : '');
    return scalar.trim() ? resolveArtistCredit(scalar.trim(), evidence).slice(0, 64) : [];
}
function storedCredits(value: unknown): Credit[] {
    return Array.isArray(value)
        ? value.filter(
              (entry: unknown): entry is Credit =>
                  typeof entry === 'object' &&
                  entry !== null &&
                  'credited_name' in entry &&
                  typeof entry.credited_name === 'string' &&
                  'id' in entry &&
                  (entry.id === null || (typeof entry.id === 'string' && UUID.test(entry.id))),
          )
        : [];
}
function titleRemixerMembership(
    meta: Record<string, unknown>,
    titleIds: string[],
): {
    title_remixer_artist_ids: string[];
    independent_remixer_artist_ids: string[];
    remixer_artist_ids: string[];
} {
    const previousTitle = new Set(ids(meta.title_remixer_artist_ids));
    const independent = [
        ...new Set([
            ...ids(meta.independent_remixer_artist_ids),
            ...ids(meta.remixer_artist_ids).filter((id) => !previousTitle.has(id)),
        ]),
    ];
    return {
        title_remixer_artist_ids: [...new Set(titleIds)],
        independent_remixer_artist_ids: independent,
        remixer_artist_ids: [...new Set([...independent, ...titleIds])],
    };
}
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (!list) map.set(key, [value]);
    else if (!list.includes(value)) list.push(value);
}

/** Every active top-level artist, indexed by identity key, alias key and MusicBrainz id. */
class ArtistIndex {
    readonly byTitle = new Map<string, string[]>();
    readonly byAlias = new Map<string, string[]>();
    readonly byMbid = new Map<string, string[]>();
    readonly mbidsById = new Map<string, string[]>();
    readonly active = new Set<string>();
    /** Name -> identity key, as PostgreSQL computes it. */
    readonly keys = new Map<string, string>();
    /** Identity key -> in-flight artist insert. */
    readonly creating = new Map<string, Promise<string | null>>();

    static async load(sql: postgres.Sql): Promise<ArtistIndex> {
        const index = new ArtistIndex();
        // Trusted migration repair over the catalog; nothing is returned to a user.
        const rows = await sql<
            { id: string; key: string; alias_keys: string[]; mbids: string[] }[]
        >`
            SELECT a.id, LOWER(TRIM(normalize(a.title, NFC))) AS key,
                ARRAY(SELECT LOWER(TRIM(normalize(alias, NFC)))
                      FROM jsonb_array_elements_text(CASE
                          WHEN jsonb_typeof(a.custom_metadata->'scan_aliases') = 'array'
                          THEN a.custom_metadata->'scan_aliases' ELSE '[]'::jsonb END) alias) AS alias_keys,
                ARRAY(SELECT LOWER(ei.external_id) FROM external_ids ei
                      WHERE ei.media_id = a.id AND ei.provider = 'musicbrainz' AND ei.media_type = 'artist'
                      UNION SELECT LOWER(a.custom_metadata->>'musicbrainz_artist_id')
                      WHERE a.custom_metadata->>'musicbrainz_artist_id' IS NOT NULL) AS mbids
            FROM media_items a
            WHERE a.media_type = 'artist' AND a.parent_id IS NULL AND a.status = 'active'
            ORDER BY a.created_at ASC, a.id ASC
        `;
        for (const row of rows) index.add(row.id, row.key, row.alias_keys, row.mbids);
        return index;
    }

    add(id: string, key: string, aliasKeys: string[] = [], mbids: string[] = []): void {
        this.active.add(id);
        pushTo(this.byTitle, key, id);
        for (const alias of aliasKeys) pushTo(this.byAlias, alias, id);
        this.mbidsById.set(id, mbids);
        for (const mbid of mbids) pushTo(this.byMbid, mbid, id);
    }

    /** Key every not-yet-keyed name in one round trip. */
    async keyNames(sql: postgres.Sql, input: Iterable<string>): Promise<void> {
        const pending = [...new Set(input)].filter((name) => !this.keys.has(name));
        if (pending.length === 0) return;
        const rows = await sql<{ name: string; key: string }[]>`
            SELECT n AS name, LOWER(TRIM(normalize(n, NFC))) AS key
            FROM unnest(${sql.array(pending)}::text[]) AS n
        `;
        for (const row of rows) this.keys.set(row.name, row.key);
    }

    key(name: string): string {
        // Every name is keyed up front; the JS fallback only guards a miss.
        return this.keys.get(name) ?? name.normalize('NFC').trim().toLowerCase();
    }

    /** Title or scan-alias match, distinct artists. */
    nameMatches(name: string): string[] {
        const key = this.key(name);
        return [...new Set([...(this.byTitle.get(key) ?? []), ...(this.byAlias.get(key) ?? [])])];
    }

    providerMatches(mbid: string): string[] {
        return this.byMbid.get(mbid.toLowerCase()) ?? [];
    }

    isActiveCredit(id: string, providerId?: string): boolean {
        if (!this.active.has(id)) return false;
        if (!providerId) return true;
        const mbid = providerId.toLowerCase();
        return (
            (this.mbidsById.get(id) ?? []).every((known) => known === mbid) &&
            this.providerMatches(mbid).every((other) => other === id)
        );
    }

    /** Match-only lookup (remixer title credits); never Various Artists. */
    findByName(name: string): string | null {
        if (isVariousArtistsName(name)) return null;
        const matches = this.nameMatches(name);
        return matches.length === 1 ? matches[0] : null;
    }
}

interface RepairContext {
    /** Root pool: artist creation commits on its own (see createArtist). */
    sql: postgres.Sql;
    tx: postgres.TransactionSql;
    index: ArtistIndex;
    evidence: ArtistCreditEvidence;
    stats: FrozenArtistCreditRepairResult;
}

/** Same decision order as resolveMusicArtistCredit + findOrCreateMusicArtist, without throwing. */
async function resolveCredit(
    ctx: RepairContext,
    name: string,
    providerId: string | undefined,
    libraryGroupId: string | null,
): Promise<string | null> {
    const { index } = ctx;
    const mbid = providerId?.toLowerCase();
    if (mbid && !UUID.test(mbid)) return null;
    if (mbid) {
        const known = index.providerMatches(mbid);
        if (known.length > 1) return null;
        if (known[0]) {
            const claims = index.mbidsById.get(known[0]) ?? [];
            return claims.some((id) => id !== mbid) ? null : known[0];
        }
    }
    const candidates = index.nameMatches(name);
    if (candidates.length > 1) return null;
    if (candidates[0]) {
        const claims = index.mbidsById.get(candidates[0]) ?? [];
        if (mbid && claims.some((id) => id !== mbid)) return null;
        return candidates[0];
    }
    const isVa = isVariousArtistsName(name);
    const title = isVa ? VARIOUS_ARTISTS_LABEL : name.normalize('NFC');
    if (isVa) {
        await index.keyNames(ctx.tx, [title]);
        const existing = index.nameMatches(title);
        if (existing.length === 1) return existing[0];
        if (existing.length > 1) return null;
    }
    return createArtist(ctx, title, isVa, libraryGroupId);
}

async function createArtist(
    ctx: RepairContext,
    title: string,
    isVa: boolean,
    libraryGroupId: string | null,
): Promise<string | null> {
    // The title can differ from the name that was keyed (NFC, VA label).
    await ctx.index.keyNames(ctx.sql, [title]);
    const key = ctx.index.key(title);
    // Concurrent batches asking for the same new artist share one insert.
    let pending = ctx.index.creating.get(key);
    if (!pending) {
        pending = insertArtist(ctx.sql, title, isVa, libraryGroupId).then((id) => {
            if (id && !ctx.index.active.has(id)) {
                ctx.stats.createdArtists++;
                ctx.index.add(id, key);
            }
            return id;
        });
        ctx.index.creating.set(key, pending);
        void pending.finally(() => ctx.index.creating.delete(key)).catch(() => undefined);
    }
    return pending;
}

/**
 * Autocommit, outside the batch transaction: an uncommitted artist would hold
 * its unique-index entry until the batch commits, so batches creating the
 * same artists in opposite orders could deadlock, and a rolled-back batch
 * would leave ids in the shared index that no longer exist. An artist created
 * for a batch that then fails is reused by the per-track retry.
 *
 * Target-less ON CONFLICT: whichever artist unique index this database has is
 * the arbiter. A conflict means a concurrent scanner (an old pod during a
 * rolling deploy) created it; read it back by the identity key.
 */
async function insertArtist(
    sql: postgres.Sql,
    title: string,
    isVa: boolean,
    libraryGroupId: string | null,
): Promise<string | null> {
    // A short lock timeout: this insert can wait on another session's
    // uncommitted insert of the same name while our batch, which awaits it in
    // JS, holds row locks that session may want. PostgreSQL cannot see that
    // cycle; the timeout fails the batch, and the per-track retry recovers.
    const inserted = await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        const [row] = await tx<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, library_group_id, is_various_artists)
            VALUES (${title}, 'artist', ${libraryGroupId}, ${isVa})
            ON CONFLICT DO NOTHING
            RETURNING id
        `;
        return row;
    });
    if (inserted) return inserted.id;
    const existing = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE media_type = 'artist' AND parent_id IS NULL AND status = 'active'
          AND LOWER(TRIM(normalize(title, NFC))) = LOWER(TRIM(normalize(${title}, NFC)))
        ORDER BY created_at ASC LIMIT 2
    `;
    return existing.length === 1 ? existing[0].id : null;
}

/** Every name a track's credits can look up, so one query keys the whole batch. */
function namesToKey(row: TrackRow, evidence: ArtistCreditEvidence): string[] {
    const meta = row.custom_metadata;
    const plain = (name: string): string => name.normalize('NFC').trim().toLowerCase();
    const all = [
        ...names(meta, 'artists', 'artist', evidence, plain),
        ...names(meta, 'album_artists', 'album_artist', evidence, plain),
        ...strings(meta.artists).map((name) => name.trim()),
        ...(typeof meta.artist === 'string' ? [clampTagText(meta.artist).trim()] : []),
        ...extractRemixerCandidates(row.title).flatMap((c) => resolveArtistCredit(c, evidence)),
    ];
    return all.filter(Boolean);
}

/** The 16.394.0 credit derivation for one track, as of 2026-10-20. */
async function buildPatch(ctx: RepairContext, row: TrackRow): Promise<Record<string, unknown>> {
    const { index, evidence } = ctx;
    const meta = row.custom_metadata;
    const key = (name: string): string => index.key(name);
    const previousCredits = storedCredits(meta.track_artist_credits);
    let performers = names(meta, 'artists', 'artist', evidence, key);
    const albums = names(meta, 'album_artists', 'album_artist', evidence, key);
    const providerIds = ids(meta.musicbrainz_artist_ids);
    const explicitNames = strings(meta.artists);
    const wholeScalar =
        explicitNames[0] ?? (typeof meta.artist === 'string' ? clampTagText(meta.artist) : '');
    if (
        providerIds.length === 1 &&
        Array.isArray(meta.musicbrainz_artist_ids) &&
        meta.musicbrainz_artist_ids.length === 1 &&
        explicitNames.length <= 1 &&
        wholeScalar.trim() &&
        index.providerMatches(providerIds[0]).length > 0
    ) {
        // A verified indivisible act outranks name-splitting evidence.
        performers = [wholeScalar.trim()];
    }
    const aligned =
        Array.isArray(meta.musicbrainz_artist_ids) &&
        meta.musicbrainz_artist_ids.length === providerIds.length &&
        providerIds.length === performers.length &&
        (strings(meta.artists).length === performers.length || performers.length === 1);
    const source = { performers, albums, provider_ids: aligned ? providerIds : [] };
    const previousSource =
        typeof meta.artist_credit_source === 'object' && meta.artist_credit_source !== null
            ? (meta.artist_credit_source as Record<string, unknown>)
            : undefined;

    const credits: Credit[] = [];
    for (const [i, name] of performers.entries()) {
        const providerId = aligned ? providerIds[i] : undefined;
        const prior = previousCredits.find((credit) => key(credit.credited_name) === key(name));
        const previousIndex = previousSource
            ? strings(previousSource.performers).findIndex((value) => key(value) === key(name))
            : -1;
        const providerEvidenceUnchanged =
            !previousSource ||
            (previousIndex >= 0 &&
                (strings(previousSource.provider_ids)[previousIndex] ?? undefined) === providerId);
        const retain =
            providerEvidenceUnchanged && prior?.id && index.isActiveCredit(prior.id, providerId);
        const id =
            retain && prior?.id
                ? prior.id
                : await resolveCredit(ctx, name, providerId, row.library_group_id);
        // Unresolved duplicates differing only in case/NFC are one credit.
        if (
            !credits.some((credit) =>
                id ? credit.id === id : !credit.id && key(credit.credited_name) === key(name),
            )
        ) {
            credits.push({ id, credited_name: name });
        }
    }
    const albumIds: string[] = [];
    const previousAlbumIds = ids(meta.album_artist_ids);
    for (const name of albums) {
        const previousIndex = previousSource
            ? strings(previousSource.albums).findIndex((value) => key(value) === key(name))
            : -1;
        const priorId =
            previousIndex >= 0 && strings(previousSource?.albums).length === previousAlbumIds.length
                ? previousAlbumIds[previousIndex]
                : undefined;
        const id =
            priorId && index.isActiveCredit(priorId)
                ? priorId
                : await resolveCredit(ctx, name, undefined, row.library_group_id);
        if (id && !albumIds.includes(id)) albumIds.push(id);
    }
    const titleRemixerIds: string[] = [];
    for (const candidate of extractRemixerCandidates(row.title)) {
        for (const name of resolveArtistCredit(candidate, evidence)) {
            const id = index.findByName(name);
            if (id && !titleRemixerIds.includes(id)) titleRemixerIds.push(id);
        }
    }
    const remixerMembership = titleRemixerMembership(meta, titleRemixerIds);
    const fileIds = credits.flatMap((credit) => (credit.id ? [credit.id] : []));
    const previousOwned = new Set([
        ...ids(meta.file_artist_ids),
        ...ids(meta.album_artist_ids),
        ...ids(meta.remixer_artist_ids),
    ]);
    const independent = ids(meta.additional_artist_ids).filter((id) => !previousOwned.has(id));
    const nextIds = [
        ...new Set([
            ...independent,
            ...fileIds,
            ...albumIds,
            ...remixerMembership.remixer_artist_ids,
        ]),
    ];
    const raw = meta.raw_artist_tags ?? {
        source: 'stored_metadata',
        ...(typeof meta.artist === 'string' ? { artist: clampTagText(meta.artist) } : {}),
        ...(Array.isArray(meta.artists) ? { artists: strings(meta.artists) } : {}),
        ...(typeof meta.album_artist === 'string'
            ? { album_artist: clampTagText(meta.album_artist) }
            : {}),
        ...(Array.isArray(meta.album_artists)
            ? { album_artists: strings(meta.album_artists) }
            : {}),
        ...(providerIds.length ? { musicbrainz_artist_ids: providerIds } : {}),
    };
    return {
        raw_artist_tags: raw,
        track_artist_credits: credits,
        file_artist_ids: fileIds,
        album_artist_ids: albumIds,
        ...remixerMembership,
        artist_credit_source: source,
        additional_artist_ids: nextIds,
    };
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Returns false when even the marker could not be written (database gone?). */
async function markFailed(
    sql: postgres.Sql,
    stats: FrozenArtistCreditRepairResult,
    trackId: string,
    error: unknown,
): Promise<boolean> {
    stats.failed++;
    if (stats.errors.length < 100) stats.errors.push({ trackId, error: message(error) });
    logger.warn('Artist-credit repair failed for one track; the next library scan retries it', {
        trackId,
        error: message(error),
    });
    try {
        await withCaptureSuspended(sql, async (tx) => {
            const marker = { error: message(error).slice(0, 500), at: new Date().toISOString() };
            await tx`
                UPDATE media_items
                SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
                    || jsonb_build_object('artist_credit_repair_error', ${tx.json(marker)}::jsonb)
                WHERE id = ${trackId}
            `;
        });
        return true;
    } catch (markError) {
        logger.warn('Could not record the artist-credit repair failure on the track', {
            trackId,
            error: message(markError),
        });
        return false;
    }
}

/**
 * One transaction for the batch; on failure, each track alone so one bad row
 * cannot hold back the others. Throws only when a single track's write AND
 * its failure marker both fail: that is the database, not the data, and the
 * migration must fail (and resume on the next boot) rather than record success.
 */
async function repairBatch(
    sql: postgres.Sql,
    trackIds: string[],
    index: ArtistIndex,
    evidence: ArtistCreditEvidence,
    stats: FrozenArtistCreditRepairResult,
): Promise<void> {
    const failures: { id: string; error: unknown }[] = [];
    try {
        const updated = await withCaptureSuspended(sql, async (tx): Promise<number> => {
            // A row an old pod's scanner holds fails this batch fast; the
            // per-track retry below then isolates it.
            await tx`SET LOCAL lock_timeout = '10s'`;
            let mark = Date.now();
            const lap = (phase: keyof FrozenArtistCreditRepairResult['phasesMs']): void => {
                const now = Date.now();
                stats.phasesMs[phase] += now - mark;
                mark = now;
            };
            const rows = await tx<TrackRow[]>`
                SELECT id, COALESCE(custom_metadata, '{}'::jsonb) AS custom_metadata,
                       library_group_id, title, metadata_locked
                FROM media_items
                WHERE id = ANY(${sql.array(trackIds)}::uuid[])
                  AND media_type = 'track' AND status = 'active'
                ORDER BY id
                FOR UPDATE
            `;
            lap('lock');
            await index.keyNames(
                tx,
                rows.flatMap((row) => namesToKey(row, evidence)),
            );
            const ctx: RepairContext = { sql, tx, index, evidence, stats };
            const patches: { id: string; patch: Record<string, unknown> }[] = [];
            for (const row of rows) {
                // Curated identities on a locked row are the operator's.
                if (row.metadata_locked && Array.isArray(row.custom_metadata.track_artist_credits))
                    continue;
                try {
                    patches.push({ id: row.id, patch: await buildPatch(ctx, row) });
                } catch (error) {
                    failures.push({ id: row.id, error });
                }
            }
            lap('derive');
            if (patches.length === 0) return 0;
            const changed = await tx<{ id: string }[]>`
                UPDATE media_items m
                SET custom_metadata = COALESCE(m.custom_metadata, '{}'::jsonb) - 'artist_credit_repair_error'
                    || x.patch
                FROM jsonb_to_recordset(${tx.json(patches as unknown as Record<string, never>[])})
                    AS x(id uuid, patch jsonb)
                WHERE m.id = x.id
                RETURNING m.id
            `;
            lap('write');
            return changed.length;
        });
        stats.updated += updated;
    } catch (error) {
        if (trackIds.length === 1) {
            if (!(await markFailed(sql, stats, trackIds[0], error))) throw error;
            return;
        }
        for (const id of trackIds) await repairBatch(sql, [id], index, evidence, stats);
        return;
    }
    for (const failure of failures) {
        if (!(await markFailed(sql, stats, failure.id, failure.error))) throw failure.error;
    }
}

/** Repair every active track that has no canonical credit source yet. */
export async function repairTrackArtistCreditsFrozen(
    sql: postgres.Sql,
    options: { batchSize?: number; concurrency?: number } = {},
): Promise<FrozenArtistCreditRepairResult> {
    const started = Date.now();
    const batchSize = options.batchSize ?? REPAIR_BATCH_SIZE;
    // Most of the time is the music-people projection trigger, per row, in
    // PostgreSQL; independent batches on a few connections overlap it.
    // Each batch holds a pooled connection while its new artists insert on
    // another; leave the migration lock's connection and one spare free, or
    // a small pool (LUMASTRA_DB_POOL_WEB_MAX) waits on itself forever.
    const poolMax = (sql as { options?: { max?: number } }).options?.max ?? 8;
    const concurrency = Math.max(
        1,
        Math.min(options.concurrency ?? REPAIR_CONCURRENCY, poolMax - 3),
    );
    const stats: FrozenArtistCreditRepairResult = {
        scanned: 0,
        updated: 0,
        failed: 0,
        createdArtists: 0,
        durationMs: 0,
        phasesMs: { select: 0, lock: 0, derive: 0, write: 0 },
        errors: [],
    };
    const evidence = await loadEvidence(sql);
    const index = await ArtistIndex.load(sql);
    const inFlight = new Set<Promise<void>>();
    let failure: unknown = null;
    let cursor: string | null = null;
    try {
        while (failure === null) {
            const selectStarted = Date.now();
            const rows: { id: string }[] = await sql`
                SELECT id FROM media_items
                WHERE media_type = 'track' AND status = 'active'
                  AND ${cursor === null ? sql`true` : sql`id > ${cursor}::uuid`}
                  AND NOT (COALESCE(custom_metadata, '{}'::jsonb) ? 'artist_credit_source')
                  AND NOT (metadata_locked AND COALESCE(jsonb_typeof(custom_metadata->'track_artist_credits') = 'array', false))
                ORDER BY id LIMIT ${batchSize}
            `;
            stats.phasesMs.select += Date.now() - selectStarted;
            if (rows.length === 0) break;
            stats.scanned += rows.length;
            cursor = rows[rows.length - 1].id;
            const job: Promise<void> = repairBatch(
                sql,
                rows.map((row) => row.id),
                index,
                evidence,
                stats,
            )
                .catch((error: unknown) => {
                    failure ??= error;
                })
                .finally(() => inFlight.delete(job));
            inFlight.add(job);
            if (inFlight.size >= concurrency) await Promise.race(inFlight);
            if (stats.scanned % (batchSize * 20) === 0) {
                logger.info('Artist-credit repair progress', {
                    scanned: stats.scanned,
                    updated: stats.updated,
                    failed: stats.failed,
                    elapsedMs: Date.now() - started,
                });
            }
        }
    } finally {
        await Promise.allSettled(inFlight);
    }
    if (failure !== null) throw failure;
    stats.durationMs = Date.now() - started;
    logger.info('Artist-credit repair finished', {
        scanned: stats.scanned,
        updated: stats.updated,
        failed: stats.failed,
        createdArtists: stats.createdArtists,
        durationMs: stats.durationMs,
        phasesMs: stats.phasesMs,
    });
    return stats;
}
