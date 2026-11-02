// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/radio/index.ts
 *
 * GET  /api/admin/radio — list all radio stations
 * POST /api/admin/radio — create a new station (optionally auto-fetching a favicon)
 *
 * Auth: admin (providers:admin intent).  Surface: internal.
 * Scope: { kind: 'admin' } — internal admin BFF; no v1 surface.
 *
 * GET  response: bare object { stations: [...] }
 * POST response: bare object { id, name, streamUrl, genre?, description?, logoUrl? }
 * 503  dependency_unavailable on DB down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { CreateRadioStationSchema, RadioMetadataSourceSchema } from '$lib/schemas/radio.js';
import type { RadioMetadataSource } from '$lib/schemas/radio.js';
import { peekCacheRecord } from '$lib/server/services/radio-metadata/index.js';
import { metadataSourceIssues } from '$lib/server/services/radio-metadata/validate-source.js';
import { storeMediaImage } from '$lib/server/services/media-image-storage.service.js';
import { assertNotPrivateUrl } from '$lib/server/utils/ssrf-guard.js';
import { Logger } from '$lib/server/utils/logger.js';
import { refreshSortTitles } from '$lib/server/database/queries/sort-title.queries.js';
import type postgres from 'postgres';
import { entityImageUrl } from '$lib/shared/api-urls.js';

const logger = Logger.for('AdminRadioAPI');

// ── row types ─────────────────────────────────────────────────────────────────

interface RadioRow {
    id: string;
    title: string;
    custom_metadata: Record<string, unknown>;
    custom_poster_url: string | null;
}

// ── response schemas ──────────────────────────────────────────────────────────

const RadioStationItemSchema = z.object({
    id: z.string().guid(),
    name: z.string(),
    streamUrl: z.string(),
    genre: z.string().optional(),
    description: z.string().optional(),
    logoUrl: z.string().optional(),
    nowPlaying: z.string().optional(),
    metadataSource: RadioMetadataSourceSchema.optional(),
    lastError: z
        .object({
            at: z.string(),
            message: z.string(),
        })
        .optional(),
});

const RadioListResponseSchema = z.object({
    stations: z.array(RadioStationItemSchema),
});

const RadioCreateResponseSchema = z.object({
    id: z.string().guid(),
    name: z.string(),
    streamUrl: z.string(),
    genre: z.string().optional(),
    description: z.string().optional(),
    logoUrl: z.string().optional(),
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function tryAutoFetchFavicon(
    sql: postgres.Sql,
    mediaItemId: string,
    streamUrl: string,
): Promise<string | null> {
    try {
        const parsed = new URL(streamUrl);
        const candidates = [
            `${parsed.protocol}//${parsed.host}/favicon.png`,
            `${parsed.protocol}//${parsed.host}/favicon.ico`,
            `${parsed.protocol}//${parsed.host}/apple-touch-icon.png`,
        ];
        for (const candidate of candidates) {
            try {
                await assertNotPrivateUrl(new URL(candidate));
                const result = await storeMediaImage(sql, mediaItemId, 'poster', {
                    type: 'url',
                    url: candidate,
                });
                logger.info('Auto-fetched favicon', { mediaItemId, source: candidate });
                return result.serveUrl;
            } catch {
                // Try next candidate
            }
        }
    } catch (err) {
        logger.debug('Favicon auto-fetch skipped', {
            mediaItemId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return null;
}

// ── def ───────────────────────────────────────────────────────────────────────

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: CreateRadioStationSchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rows = await sql<RadioRow[]>`
                SELECT
                    id,
                    title,
                    COALESCE(custom_metadata, '{}'::jsonb) AS custom_metadata,
                    custom_poster_url
                FROM media_items
                WHERE media_type = 'radio'
                ORDER BY title ASC
            `;

            const stationsPartial = rows.map((row) => ({
                id: row.id,
                name: row.title,
                streamUrl: (row.custom_metadata.stream_url as string) ?? '',
                genre: row.custom_metadata.genre as string | undefined,
                description: row.custom_metadata.description as string | undefined,
                logoUrl: row.custom_poster_url
                    ? entityImageUrl(row.id, 'poster', ctx.surface)
                    : undefined,
                nowPlaying: row.custom_metadata.now_playing as string | undefined,
                metadataSource: row.custom_metadata.metadata_source as
                    RadioMetadataSource | undefined,
            }));

            const stations = await Promise.all(
                stationsPartial.map(async (s) => {
                    if (!s.metadataSource) return s;
                    const record = await peekCacheRecord(s.id);
                    return record?._lastError ? { ...s, lastError: record._lastError } : s;
                }),
            );

            return json(RadioListResponseSchema.parse({ stations }));
        },

        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            let body: z.infer<typeof CreateRadioStationSchema>;
            try {
                const raw: unknown = await event.request.json();
                const parsed = CreateRadioStationSchema.safeParse(raw);
                if (!parsed.success) {
                    return ApiProblem.validationFailed(
                        parsed.error.issues.map((i) => ({
                            field: i.path.join('.'),
                            message: i.message,
                        })),
                    );
                }
                body = parsed.data;
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }

            const { name, streamUrl, genre, description, logoUrl, metadataSource } = body;

            // An unsafe now-playing regex is refused here, at save time, not
            // only per poll (security review 2026-09-12, C7).
            const sourceIssues = metadataSourceIssues(metadataSource);
            if (sourceIssues) return ApiProblem.validationFailed(sourceIssues);

            const metadata: Record<string, unknown> = { stream_url: streamUrl };
            if (genre) metadata.genre = genre;
            if (description) metadata.description = description;
            if (metadataSource) metadata.metadata_source = metadataSource;

            const [inserted] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, custom_metadata)
                VALUES (${name}, 'radio', ${sql.json(metadata as never)})
                RETURNING id
            `;

            const id = inserted.id;
            await refreshSortTitles(sql, [id]);

            let finalLogoUrl: string | null = null;
            if (logoUrl) {
                try {
                    await assertNotPrivateUrl(new URL(logoUrl));
                    const result = await storeMediaImage(sql, id, 'poster', {
                        type: 'url',
                        url: logoUrl,
                    });
                    finalLogoUrl = result.serveUrl;
                } catch (err) {
                    logger.warn('Provided logo URL failed to download', {
                        id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            } else {
                finalLogoUrl = await tryAutoFetchFavicon(sql, id, streamUrl);
            }

            logger.info('Radio station created', {
                id,
                name,
                streamUrl,
                logoFetched: finalLogoUrl !== null,
            });

            return json(
                RadioCreateResponseSchema.parse({
                    id,
                    name,
                    streamUrl,
                    genre,
                    description,
                    logoUrl: finalLogoUrl ?? undefined,
                }),
            );
        },
    },
});
