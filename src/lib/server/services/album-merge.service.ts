// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { isRecord } from '$lib/utils/data-extraction.js';
import type postgres from 'postgres';
import type {
    AlbumMergeOptions,
    AlbumMergePreview,
    AlbumMergeResult,
} from '$lib/schemas/album-merge.js';
import { AlbumMergeOptionsSchema, AlbumMergeResultSchema } from '$lib/schemas/album-merge.js';
import { withTx } from '../database/with-tx.js';
import {
    lockMediaPair,
    moveMediaReferences,
    MOVED_MEDIA_REFERENCE_COLUMNS,
    MOVED_POLYMORPHIC_REFERENCE_TABLES,
} from '../database/queries/media-reference-migration.queries.js';
import {
    findMusicArtistByName,
    findOrCreateMusicArtist,
} from '../database/queries/media-items.queries.js';
import {
    lockAncestorChain,
    recomputeHasFilesBatch,
} from '../database/queries/media-files.queries.js';
import { insertAdminAuditEvent } from '../database/queries/admin-audit.queries.js';
import { hasActiveLibraryScan } from '../database/queries/admin-media.queries.js';
import {
    albumFileCredit,
    resolveAlbumArtist,
    normalizeAlbumArtist,
} from '../tasks/builtin/native/media-sources/_helpers/file-scanner/album-artist-rule.js';
import { resolveArtistCredit } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/artist-credit.js';
import { getArtistCreditEvidence } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/artist-credit-evidence.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import { config } from '../config.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('AlbumMerge');

type JsonRecord = Record<string, postgres.JSONValue>;
interface AlbumMergeOutcome {
    result: AlbumMergeResult;
    replayed: boolean;
}
interface AlbumRow {
    id: string;
    title: string;
    created_at: Date;
    parent_id: string | null;
    parent_title: string | null;
    metadata_locked: boolean;
    library_group_id: string | null;
    data: JsonRecord;
}
interface TrackRow {
    id: string;
    title: string;
    parent_id: string;
    custom_metadata: JsonRecord;
    disc: string | null;
    number: string | null;
    live: boolean;
    data: JsonRecord;
}
interface ReferenceSnapshot {
    table: string;
    sourceCount: number;
    survivorCount: number;
    digest: string;
}
export class AlbumMergeError extends Error {
    constructor(
        readonly reason: 'missing' | 'invalid' | 'conflict',
        message: string,
    ) {
        super(message);
    }
}
const extraReferences = [
    { table: 'provider_metadata', column: 'media_id' },
    { table: 'media_item_stage_state', column: 'media_item_id' },
];

/** Lock existing reference values too: updating a rating need not re-check its unchanged album FK. */
async function lockReferences(sql: postgres.Sql, ids: string[]): Promise<void> {
    for (const { table, column } of [...MOVED_MEDIA_REFERENCE_COLUMNS, ...extraReferences]) {
        await sql`SELECT 1 FROM ${sql(table)} r WHERE r.${sql(column)}=ANY(${ids}::uuid[]) ORDER BY r.ctid FOR UPDATE`;
    }
    await sql`SELECT 1 FROM image_provider_suppressions WHERE owner=ANY(${ids}::text[]) ORDER BY owner,provider,role FOR UPDATE`;
    for (const table of MOVED_POLYMORPHIC_REFERENCE_TABLES) {
        await sql`SELECT 1 FROM ${sql(table)} r WHERE lower(replace(target_id,'-',''))=ANY(${ids.map((id) => id.replace(/-/g, ''))}::text[])
            AND target_type IN ('media','album','artist','movie','series','episode','track','audiobook','season') ORDER BY r.ctid FOR UPDATE`;
    }
    // Administrative merge maintenance; the endpoint enforces admin access.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await sql`SELECT f.id FROM media_files f WHERE f.id IN (
        SELECT fi.file_id FROM media_file_items fi JOIN media_items t ON t.id=fi.media_item_id WHERE t.parent_id=ANY(${ids}::uuid[])
    ) ORDER BY f.id FOR SHARE`;
}

/** A digest covers values, not just counts: changing a rating also invalidates a preview. */
async function references(
    sql: postgres.Sql,
    source: string,
    survivor: string,
): Promise<ReferenceSnapshot[]> {
    type Fragment = postgres.PendingQuery<postgres.Row[]>;
    const fragments: Fragment[] = [...MOVED_MEDIA_REFERENCE_COLUMNS, ...extraReferences].map(
        ({ table, column }) => sql`
        SELECT ${table}::text AS table, count(*) FILTER (WHERE r.${sql(column)}=${source}::uuid)::int AS "sourceCount",
            count(*) FILTER (WHERE r.${sql(column)}=${survivor}::uuid)::int AS "survivorCount",
            md5(COALESCE(string_agg(to_jsonb(r)::text, '' ORDER BY to_jsonb(r)::text), '')) AS digest
        FROM ${sql(table)} r WHERE r.${sql(column)} IN (${source}::uuid, ${survivor}::uuid)
    `,
    );
    fragments.push(sql`
        SELECT 'image_provider_suppressions'::text AS table,
            count(*) FILTER (WHERE owner=${source})::int AS "sourceCount",
            count(*) FILTER (WHERE owner=${survivor})::int AS "survivorCount",
            md5(COALESCE(string_agg(to_jsonb(r)::text, '' ORDER BY to_jsonb(r)::text), '')) AS digest
        FROM image_provider_suppressions r WHERE owner IN (${source}, ${survivor})
    `);
    for (const table of MOVED_POLYMORPHIC_REFERENCE_TABLES) {
        fragments.push(sql`
            SELECT ${table}::text AS table,
                count(*) FILTER (WHERE lower(replace(target_id,'-',''))=replace(${source},'-',''))::int AS "sourceCount",
                count(*) FILTER (WHERE lower(replace(target_id,'-',''))=replace(${survivor},'-',''))::int AS "survivorCount",
                md5(COALESCE(string_agg(to_jsonb(r)::text, '' ORDER BY to_jsonb(r)::text), '')) AS digest
            FROM ${sql(table)} r WHERE lower(replace(target_id,'-','')) IN (replace(${source},'-',''),replace(${survivor},'-',''))
              AND target_type IN ('media','album','artist','movie','series','episode','track','audiobook','season')
        `);
    }
    const union = fragments.reduce((a, b) => sql`${a} UNION ALL ${b}`);
    return await sql<
        ReferenceSnapshot[]
    >`SELECT * FROM (${union}) snapshots ORDER BY "table" COLLATE "C"`;
}
function policy(table: string): AlbumMergePreview['albumData'][number]['policy'] {
    if (['provider_metadata', 'media_item_stage_state'].includes(table))
        return 'archive-enrichment';
    if (table === 'media_artwork' || table === 'image_candidates') return 'artwork-alternatives';
    if (['user_media_state', 'user_music_state'].includes(table)) return 'merge-user-state';
    if (
        [
            'watchlist_activities',
            'play_sessions',
            'watch_history',
            'interactions',
            'user_media_events_archive',
            'hls_playback_tokens',
        ].includes(table)
    )
        return 'move-all';
    return 'survivor-wins';
}

async function plan(sql: postgres.Sql, input: AlbumMergeOptions): Promise<AlbumMergePreview> {
    // Whole-row JSON and reference digests contain timestamptz values. PostgreSQL
    // renders those in the session timezone, so otherwise two connections can
    // fingerprint identical rows differently. Both callers run in a transaction;
    // normalize here before any snapshots, retaining database microsecond precision.
    await sql`SET LOCAL TIME ZONE 'UTC'`;
    const ids = [input.keepId.toLowerCase(), input.mergeId.toLowerCase()].sort();
    if (ids[0] === ids[1]) throw new AlbumMergeError('invalid', 'Choose two different albums');
    // Admin pair lookup; never used to list media for viewers.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const albums = await sql<AlbumRow[]>`
        SELECT a.id,a.title,a.created_at,a.parent_id,p.title AS parent_title,a.metadata_locked,a.library_group_id,to_jsonb(a) AS data
        FROM media_items a LEFT JOIN media_items p ON p.id=a.parent_id
        WHERE a.id=ANY(${ids}::uuid[]) AND a.media_type='album' AND a.status='active' AND NOT a.is_dismissed
        ORDER BY a.created_at,a.id
    `;
    if (albums.length !== 2) throw new AlbumMergeError('missing', 'Two active albums are required');
    const selectedId = input.survivorId?.toLowerCase();
    const survivor = selectedId ? albums.find((a) => a.id === selectedId) : albums[0];
    if (!survivor)
        throw new AlbumMergeError('invalid', 'The survivor must be one of the two albums');
    const source = albums.find((a) => a.id !== survivor.id)!;
    // Locking the two parents in apply blocks child insertions via the parent FK.
    // All children move, including unavailable/soft-deleted tracks; none can be orphaned by deletion.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const tracks = await sql<TrackRow[]>`
        SELECT t.id,t.title,t.parent_id,COALESCE(t.custom_metadata,'{}'::jsonb) AS custom_metadata,
            t.custom_metadata->>'disc_number' AS disc,t.custom_metadata->>'track_number' AS number,
            (t.status='active' AND EXISTS (SELECT 1 FROM media_file_items fi JOIN media_files f ON f.id=fi.file_id
                WHERE fi.media_item_id=t.id AND f.is_missing IS NOT TRUE)) AS live, to_jsonb(t) AS data
        FROM media_items t WHERE t.parent_id=ANY(${ids}::uuid[]) ORDER BY t.id LIMIT 2001
    `;
    if (tracks.length > 2000 || tracks.some((t) => t.data.media_type !== 'track'))
        throw new AlbumMergeError(
            'conflict',
            'Album has unsupported children or more than 2000 tracks',
        );
    // Administrative merge maintenance; the endpoint enforces admin access.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const liveFiles = await sql<{ library_group_id: string | null; data: JsonRecord }[]>`
        SELECT DISTINCT f.id, f.library_group_id, jsonb_build_object('id',f.id,'path',f.file_path,'missing',f.is_missing,'library',f.library_group_id) AS data FROM media_items t
        JOIN media_file_items fi ON fi.media_item_id=t.id JOIN media_files f ON f.id=fi.file_id
        WHERE t.parent_id=ANY(${ids}::uuid[]) AND f.is_missing IS NOT TRUE ORDER BY f.id
    `;
    if (
        new Set(liveFiles.map((f) => f.library_group_id)).size > 1 ||
        (albums[0].library_group_id &&
            albums[1].library_group_id &&
            albums[0].library_group_id !== albums[1].library_group_id)
    )
        throw new AlbumMergeError('conflict', 'Albums must belong to the same library');
    const requiresOverride = albums.some((a) => a.metadata_locked);
    const evidence = await getArtistCreditEvidence(sql);
    const credits = tracks
        .filter((t) => t.live)
        .map((t) => {
            const credit = albumFileCredit({ ...t.custom_metadata, title: t.title });
            if (!Array.isArray(t.custom_metadata.artists) && credit.primaryArtist)
                credit.primaryArtist = resolveArtistCredit(credit.primaryArtist, evidence)[0];
            return credit;
        });
    const decision = resolveAlbumArtist(credits, {
        // An explicit override authorizes deriving the combined parent again.
        locked: survivor.metadata_locked && !input.overrideLocks,
        currentArtist: survivor.parent_title ?? undefined,
        creditEvidence: evidence,
    });
    let parent = await findMusicArtistByName(sql, decision.artist);
    if (decision.various) {
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        const [va] = await sql<
            { id: string }[]
        >`SELECT id FROM media_items WHERE media_type='artist' AND parent_id IS NULL
            AND status='active' AND LOWER(TRIM(normalize(title,NFC)))=LOWER(TRIM(normalize(${decision.artist},NFC))) ORDER BY created_at,id LIMIT 1`;
        parent = va?.id ?? null;
    }
    let resultingArtistTitle = decision.artist.normalize('NFC');
    if (parent) {
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        const [parentRow] = await sql<
            { title: string }[]
        >`SELECT title FROM media_items WHERE id=${parent}`;
        resultingArtistTitle = parentRow?.title ?? resultingArtistTitle;
    }
    const resultingTitle = input.title ?? survivor.title;
    if (parent) {
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        const [collision] = await sql`
            SELECT id FROM media_items WHERE media_type='album' AND status='active' AND parent_id=${parent}
            AND lower(trim(title))=lower(trim(${resultingTitle})) AND id<>ALL(${ids}::uuid[]) LIMIT 1
        `;
        if (collision)
            throw new AlbumMergeError(
                'conflict',
                'The resulting artist already has another album with this title',
            );
    }
    const moving = tracks.filter((t) => t.parent_id === source.id);
    const kept = tracks.filter((t) => t.parent_id === survivor.id);
    const refs = await references(sql, source.id, survivor.id);
    const summary = (a: AlbumRow): AlbumMergePreview['survivor'] => ({
        id: a.id,
        title: a.title,
        createdAt: a.created_at.toISOString(),
        parentId: a.parent_id,
        parentTitle: a.parent_title,
        metadataLocked: a.metadata_locked,
        trackCount: tracks.filter((t) => t.parent_id === a.id).length,
    });
    const metadata = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
    const sourceMeta = metadata(source.data.custom_metadata);
    const survivorMeta = metadata(survivor.data.custom_metadata);
    const preview: AlbumMergePreview = {
        keepId: survivor.id,
        mergeId: source.id,
        survivor: summary(survivor),
        removed: summary(source),
        tracksToMove: moving.map((t) => ({
            id: t.id,
            title: t.title,
            albumId: t.parent_id,
            disc: t.disc,
            number: t.number,
        })),
        trackCount: moving.length,
        resultingTrackCount: tracks.length,
        resultingTitle,
        duplicateCandidates: moving.flatMap((t) =>
            kept
                .filter(
                    (k) =>
                        normalizeAlbumArtist(t.title) === normalizeAlbumArtist(k.title) &&
                        t.disc === k.disc &&
                        t.number === k.number,
                )
                .map((k) => ({ movingTrackId: t.id, survivorTrackId: k.id, title: t.title })),
        ),
        parentArtist: {
            id: parent ?? null,
            title: resultingArtistTitle,
            various: decision.various,
            source: decision.source,
        },
        selectedImages: (['poster', 'backdrop', 'logo', 'thumb'] as const).map((role) => {
            const src = source.data[`custom_${role}_url`];
            const kept = survivor.data[`custom_${role}_url`];
            const sourceUrl = typeof src === 'string' ? src : null;
            const survivorUrl = typeof kept === 'string' ? kept : null;
            const resultUrl =
                survivorUrl ??
                (sourceUrl === `/api/image/custom/${source.id}/${role}`
                    ? `/api/image/custom/${survivor.id}/${role}`
                    : sourceUrl);
            return { role, sourceUrl, survivorUrl, resultUrl };
        }),
        metadataKeys: {
            filled: Object.keys(sourceMeta ?? {}).filter((key) => !(key in (survivorMeta ?? {}))),
            conflicts: Object.keys(sourceMeta ?? {}).filter(
                (key) =>
                    key in (survivorMeta ?? {}) &&
                    JSON.stringify(sourceMeta?.[key]) !== JSON.stringify(survivorMeta?.[key]),
            ),
        },
        albumData: refs.map(({ table, sourceCount, survivorCount }) => ({
            table,
            sourceCount,
            survivorCount,
            policy: policy(table),
        })),
        locks: {
            requiresOverride,
            overridden: Boolean(input.overrideLocks),
            resultingLocked: requiresOverride,
        },
        previewToken: '',
    };
    // Everything apply can change is fingerprinted, including file availability and reference values.
    preview.previewToken = createHash('sha256')
        .update(JSON.stringify({ version: 3, preview, albums, tracks, liveFiles, refs }))
        .digest('hex');
    return preview;
}

export async function previewAlbumMerge(
    sql: postgres.Sql,
    input: AlbumMergeOptions,
): Promise<AlbumMergeResult> {
    input = AlbumMergeOptionsSchema.parse(input);
    return withTx(sql, async (tx) => {
        // No locks, cache writes or provider requests. One consistent read-only snapshot.
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        return { applied: false, preview: await plan(tx, input) };
    });
}

export async function applyAlbumMerge(
    sql: postgres.Sql,
    input: AlbumMergeOptions,
    actor: string,
): Promise<AlbumMergeResult> {
    input = AlbumMergeOptionsSchema.parse(input);
    if (!input.previewToken)
        throw new AlbumMergeError('conflict', 'Preview the album merge before applying it');
    const outcome = await withTx(sql, async (tx): Promise<AlbumMergeOutcome> => {
        const ids = [input.keepId.toLowerCase(), input.mergeId.toLowerCase()].sort();
        await lockMediaPair(tx, ids[0], ids[1]);
        const [receipt] = await tx<{ pair_ids: string[]; result: unknown }[]>`
            SELECT pair_ids,result FROM album_merge_receipts WHERE token=${input.previewToken!}
        `;
        if (receipt && JSON.stringify(receipt.pair_ids) === JSON.stringify(ids)) {
            // Receipts written before title overrides lack this required preview field.
            // Upgrade only the persisted replay payload, keeping the public schema strict.
            if (isRecord(receipt.result) && isRecord(receipt.result.preview)) {
                const preview = receipt.result.preview;
                if (isRecord(preview.survivor)) preview.resultingTitle ??= preview.survivor.title;
            }
            const replay = AlbumMergeResultSchema.parse(receipt.result);
            if (
                (input.survivorId && input.survivorId.toLowerCase() !== replay.preview.keepId) ||
                Boolean(input.overrideLocks) !== replay.preview.locks.overridden ||
                (input.title ?? replay.preview.survivor.title) !== replay.preview.resultingTitle
            )
                throw new AlbumMergeError(
                    'conflict',
                    'Replay options must match the confirmed merge',
                );
            return { result: replay, replayed: true };
        }
        await lockAncestorChain(tx, ids);
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        await tx`SELECT id FROM media_items WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        await tx`SELECT id FROM media_items WHERE parent_id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
        await lockReferences(tx, ids);
        if (await hasActiveLibraryScan(tx))
            throw new AlbumMergeError('conflict', 'A library scan is in progress');
        const preview = await plan(tx, input);
        if (preview.previewToken !== input.previewToken)
            throw new AlbumMergeError('conflict', 'The albums changed. Preview the merge again');
        if (preview.locks.requiresOverride && !input.overrideLocks)
            throw new AlbumMergeError('conflict', 'Metadata is locked. Explicit override required');
        const { keepId, mergeId } = preview;
        const artistId =
            preview.parentArtist.id ??
            (await findOrCreateMusicArtist(tx, {
                name: preview.parentArtist.title,
            }));
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        const [parentRow] = await tx<
            { title: string }[]
        >`SELECT title FROM media_items WHERE id=${artistId} FOR SHARE`;
        if (!parentRow || parentRow.title !== preview.parentArtist.title)
            throw new AlbumMergeError(
                'conflict',
                'The resulting artist changed. Preview the merge again',
            );
        // Refuse a third album with this title rather than silently merging more than the previewed pair.
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        const [collision] = await tx`
            SELECT id FROM media_items WHERE media_type='album' AND status='active' AND parent_id=${artistId}
            AND lower(trim(title))=lower(trim(${preview.resultingTitle})) AND id<>ALL(${ids}::uuid[]) LIMIT 1
        `;
        if (collision)
            throw new AlbumMergeError(
                'conflict',
                'The resulting artist already has another album with this title',
            );
        // Archive source curation, conflicting external ids and enrichment evidence before FK cascades.
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        await tx`
            UPDATE media_items w SET custom_metadata=COALESCE(w.custom_metadata,'{}'::jsonb) || jsonb_build_object(
                'scan_aliases', (SELECT jsonb_agg(DISTINCT alias) FROM (
                    SELECT value AS alias FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(w.custom_metadata->'scan_aliases')='array'
                            THEN w.custom_metadata->'scan_aliases' ELSE '[]'::jsonb END ||
                        CASE WHEN jsonb_typeof(d.custom_metadata->'scan_aliases')='array'
                            THEN d.custom_metadata->'scan_aliases' ELSE '[]'::jsonb END
                    ) WHERE jsonb_typeof(value)='string'
                    UNION SELECT to_jsonb(w.title) WHERE w.title IS DISTINCT FROM ${preview.resultingTitle}
                    UNION SELECT to_jsonb(d.title)
                ) aliases),
                'merged_albums', COALESCE(w.custom_metadata->'merged_albums','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                    'album',to_jsonb(d),
                    'externalIds',(SELECT COALESCE(jsonb_agg(to_jsonb(e)),'[]'::jsonb) FROM external_ids e WHERE e.media_id=d.id),
                    'providerMetadata',(SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM provider_metadata p WHERE p.media_id=d.id),
                    'stageState',(SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]'::jsonb) FROM media_item_stage_state s WHERE s.media_item_id=d.id),
                    'survivorEnrichment',jsonb_build_object('processingState',w.processing_state->'album-enrichment',
                        'stageState',(SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]'::jsonb) FROM media_item_stage_state s WHERE s.media_item_id=w.id AND s.stage_id='album-enrichment'))
                ))
            ) FROM media_items d WHERE w.id=${keepId} AND d.id=${mergeId}
        `;
        await moveMediaReferences(tx, mergeId, keepId);
        await tx`UPDATE media_items SET parent_id=${keepId},updated_at=now() WHERE parent_id=${mergeId}`;
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        await tx`
            UPDATE media_items w SET metadata_locked=w.metadata_locked OR d.metadata_locked,
                metadata_locked_by=COALESCE(w.metadata_locked_by,d.metadata_locked_by),
                metadata_locked_at=COALESCE(w.metadata_locked_at,d.metadata_locked_at)
            FROM media_items d WHERE w.id=${keepId} AND d.id=${mergeId}
        `;
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        await tx`DELETE FROM media_items WHERE id=${mergeId}`;
        await tx`UPDATE media_items SET title=${preview.resultingTitle},parent_id=${artistId},is_various_artists=${preview.parentArtist.various},updated_at=now(),
            processing_state=COALESCE(processing_state,'{}'::jsonb) - 'album-enrichment',
            custom_metadata=COALESCE(custom_metadata,'{}'::jsonb) || jsonb_build_object('track_count',${preview.resultingTrackCount}::int)
            WHERE id=${keepId}`;
        // Completed source enrichment is evidence, never completion for the combined album.
        await tx`UPDATE media_item_stage_state SET status='pending',invalidated_at=now(),next_eligible_at=NULL,updated_at=now()
            WHERE media_item_id=${keepId} AND stage_id='album-enrichment'`;
        const parentIds = [preview.survivor.parentId, preview.removed.parentId, artistId].filter(
            (v): v is string => Boolean(v),
        );
        await recomputeHasFilesBatch(tx, [keepId, ...parentIds]);
        await insertAdminAuditEvent(tx, {
            instanceId: config.INSTANCE_ID,
            actor,
            action: 'music.album.merge',
            target: mergeId,
            outcome: 'ok',
            detail: {
                oldId: mergeId,
                newId: keepId,
                trackCount: preview.trackCount,
                previewToken: preview.previewToken,
                overrideLocks: Boolean(input.overrideLocks),
            },
        });
        const applied = { applied: true, preview };
        await tx`INSERT INTO album_merge_receipts (token,pair_ids,result)
            VALUES (${preview.previewToken},${ids}::uuid[],${tx.json(applied)})`;
        return { result: applied, replayed: false };
    });
    const { result, replayed } = outcome;
    if (replayed) return result;
    // Post-commit hooks invalidate display/search/recommendation caches and embeddings.
    try {
        const { getImageProxyService } = await import('./image-proxy/index.js');
        const images = getImageProxyService();
        images.invalidateCatalogImage(result.preview.keepId);
        images.invalidateCatalogImage(result.preview.mergeId);
    } catch (error) {
        logger.warn('Post-merge artwork cache invalidation failed', error as Error);
    }
    try {
        await MediaLifecycleService.afterDeleted(result.preview.mergeId, sql);
        // Administrative merge maintenance; the endpoint enforces admin access.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        const [survivor] = await sql<
            { parent_id: string | null }[]
        >`SELECT parent_id FROM media_items WHERE id=${result.preview.keepId}`;
        for (const id of new Set([
            result.preview.keepId,
            result.preview.survivor.parentId,
            result.preview.removed.parentId,
            survivor?.parent_id,
        ])) {
            if (id)
                await MediaLifecycleService.afterMetadataChanged(
                    id,
                    ['title', 'parent_id', 'custom_metadata'],
                    sql,
                );
        }
        const { cacheManager, CACHE_NAMESPACES: ns } = await import('../cache/index.js');
        const { publishNamespaceClear } = await import('../cache/namespace-clear-bus.js');
        const caches = [
            ns.search,
            ns.searchResultsPage,
            ns.searchSuggestResults,
            ns.musicQuickPicksRow,
            ns.musicQuickPicksStats,
            ns.musicSimilarAlbums,
            ns.musicSimilarArtists,
            ns.musicSimilarTracks,
            ns.musicNewDiscovery,
            ns.musicNewForYou,
            ns.musicGenrePlan,
            ns.musicGenreRails,
            ns.musicLibraryGenres,
            ns.musicMoodRecommendations,
            ns.musicMoodShelf,
            ns.musicSmartMixes,
            ns.musicBecauseYouListened,
        ];
        await Promise.all(caches.map((cache) => cacheManager.for(cache).clear()));
        publishNamespaceClear(caches.map((cache) => cache.name));
    } catch (error) {
        // The receipt already committed; normal cache TTLs remain a fallback.
        logger.warn('Post-merge cache invalidation failed', error as Error);
    }
    return result;
}
