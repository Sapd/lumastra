// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { MediaPreview } from '$lib/schemas/api-media-preview.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { UserContext } from '$lib/server/types.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getMediaRailMetadataBatch } from '$lib/server/database/queries/media-rail-metadata.queries.js';
import { pickDisplayRating } from '$lib/server/utils/rating-utils.js';
import { features } from '$lib/server/config.js';
import { buildMediaPreviews } from './media-preview.service.js';
import { resolveCatalogMediaBatch, type BatchRow } from './media-id-resolver-batch.js';

export interface MediaPreviewBatchContext {
    sql: postgres.Sql;
    user: UserContext;
    surface: ApiSurface;
    /** Build once with searchAccessBoundary(buildSearchAccessContext(sql, user)), like listing. */
    access: MediaAccessBoundary;
}

/** Hash the JSON clients see. Only the item's own revision is excluded: image revisions matter. */
export function previewRevision(item: object): string {
    const fields = { ...item } as Record<string, unknown>;
    delete fields.revision;
    const sort = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(sort);
        if (value !== null && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value)
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .map(([key, child]) => [key, sort(child)]),
            );
        }
        return value;
    };
    // JSON round-trip applies normal omission, null and toJSON rules before sorting keys.
    return createHash('sha256')
        .update(JSON.stringify(sort(JSON.parse(JSON.stringify(fields)))))
        .digest('hex')
        .slice(0, 16);
}

type BatchResult<T> = { items: T[]; missing: string[] };
type DetailItem = Record<string, unknown>;
export async function hydrateMediaPreviews<I extends 'preview' | 'detail' = 'preview'>(
    ctx: MediaPreviewBatchContext,
    ids: string[],
    opts: { include?: I } = {},
): Promise<BatchResult<I extends 'detail' ? DetailItem : MediaPreview>> {
    return (await hydrate(ctx, ids, opts)) as BatchResult<I extends 'detail' ? DetailItem : MediaPreview>;
}

async function hydrate(
    ctx: MediaPreviewBatchContext,
    ids: string[],
    opts: { include?: 'preview' | 'detail' },
): Promise<BatchResult<MediaPreview | DetailItem>> {
    if (ids.length < 1 || ids.length > 100 || ids.some((id) => !id.trim())) {
        throw new RangeError('Expected 1..100 non-empty media IDs');
    }
    const unique = [...new Set(ids)];
    const rows = await resolveCatalogMediaBatch(ctx, unique);
    const byRaw = new Map(rows.map((row) => [row.raw, row]));
    const ordered: BatchRow[] = [];
    const seen = new Set<string>();
    for (const raw of unique) {
        const row = byRaw.get(raw);
        if (row && !seen.has(row.id)) {
            ordered.push(row);
            seen.add(row.id);
        }
    }
    const items: Array<MediaPreview | DetailItem> = [];
    const emitted = new Set<string>();
    if (opts.include === 'detail') {
        const { buildMediaDetail, MediaDetailResponseSchema } =
            await import('$lib/server/api/defs/catalog/media-id.js');
        // Resolution stays batched. The existing detail builder is bounded to 100 items;
        // run serially to avoid exhausting the DB pool with its nested parallel reads.
        for (const row of ordered) {
            const detail = await buildMediaDetail(
                ctx.sql,
                row.id,
                ctx.surface,
                '',
                ctx.user.userId,
                async () => ctx.access,
            );
            if (detail) {
                const parsed = MediaDetailResponseSchema.safeParse(detail);
                if (!parsed.success) continue;
                const visible = parsed.data;
                items.push({ ...visible, revision: previewRevision(visible) });
                emitted.add(row.id);
            }
        }
    } else {
        const requestsConfigured = features.requestsConfigured;
        const metadata = await getMediaRailMetadataBatch(
            ctx.sql,
            ordered.map((row) => row.id),
        );
        const previews = await buildMediaPreviews(
            ctx.sql,
            ctx.surface,
            ordered.map((row) => {
                const meta = metadata.get(row.id);
                return {
                    id: row.id,
                    type: row.media_type,
                    title: row.title,
                    ids: row.ids,
                    year: row.year,
                    overview: meta?.overview,
                    genres: meta?.genres ?? [],
                    durationMs:
                        meta?.runtimeMinutes == null
                            ? undefined
                            : Math.round(meta.runtimeMinutes * 60_000),
                    rating: meta ? pickDisplayRating(meta) : undefined,
                    isAvailable: row.has_files,
                    hasFile: row.has_files,
                    // Only titles are requestable: a file-less movie/series is a
                    // request candidate, a missing episode or season is not. Without
                    // a configured request path it is a dead end, so not requestable.
                    canRequest:
                        requestsConfigured &&
                        !row.has_files &&
                        (row.media_type === 'movie' || row.media_type === 'tv'),
                    ...(row.series_id && {
                        context: {
                            series: {
                                id: row.series_id,
                                catalogId: row.series_id,
                                title: row.series_title ?? '',
                            },
                            seasonNumber: row.season_number ?? undefined,
                            episodeNumber: row.episode_number ?? undefined,
                        },
                    }),
                };
            }),
            ctx.user.userId,
        );
        for (const preview of previews) {
            items.push({ ...preview, revision: previewRevision(preview) });
            emitted.add(preview.id);
        }
    }
    return {
        items,
        missing: unique.filter((raw) => {
            const row = byRaw.get(raw);
            return !row || !emitted.has(row.id);
        }),
    };
}
