// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * GET /Movies/Recommendations (MoviesController.GetMovieRecommendations).
 *
 * Mirrors Jellyfin's SimilarItemsManager.GetMovieRecommendationsAsync:
 * baselines are the 7 most recently watched movies and up to 10 favourites
 * (excluding those), people come from the 6 most recent; categories are
 * taken round-robin with weights [played, played, liked, liked, director,
 * actor] until `categoryLimit` is reached. Lumastra's pgvector neighbours
 * (the same search as /Items/{id}/Similar) stand in for Jellyfin's
 * genre/tag overlap. Each category is computed only when the round-robin
 * reaches it, so a small categoryLimit costs few vector searches.
 */

import { createHash } from 'node:crypto';
import { json, type RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { parseEmbedding } from '$lib/server/utils/embedding-utils';
import { findSimilarMediaDual } from '$lib/server/database/queries/suggestion-search.queries';
import { enrichMediaItemsByIds } from '$lib/server/database/queries/jellyfin-browse.queries';
import {
    findUnwatchedMoviesWithPerson,
    getMovieRecommendationSeeds,
    type RecommendationSeedRow,
} from '$lib/server/database/queries/related-media.queries';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { UserId } from '$lib/shared/user-id';
import { buildJellyfinAccessContext } from './access-context';
import { serializeBaseItems, mapRowToMediaItem } from './serializers/base-item';
import { applyJellyfinContentLanguage } from './content-language';
import { enrichItemsWithMediaSources, dropFilelessPlayables } from './media-source-enrichment';
import { enrichItemsWithProviderIds } from './provider-ids-enrichment';
import { getJfToken, getParam } from './utils';
import type { JellyfinRecommendationDto } from './types';

const logger = Logger.for('JellyfinCompat:MovieRecommendations');

type RecommendationType = JellyfinRecommendationDto['RecommendationType'];

interface Ctx {
    sql: postgres.Sql;
    userId: UserId;
    access: MediaAccessBoundary;
    itemLimit: number;
    apiKey: string;
    /** Items already placed in an earlier category, so rows don't repeat each other. */
    used: Set<string>;
}

/** Jellyfin's CategoryId for a person row is a GUID derived from the name. */
function personCategoryId(name: string): string {
    const h = createHash('md5').update(name.trim().toLowerCase()).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Hydrate ids (access + has_files re-checked), keep order, serialize. */
async function toDtos(ctx: Ctx, ids: string[]): Promise<JellyfinRecommendationDto['Items']> {
    const fresh = ids.filter((id) => !ctx.used.has(id));
    if (fresh.length === 0) return [];
    const rows = await enrichMediaItemsByIds(ctx.sql, fresh, ctx.access);
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    const items = fresh
        .filter((id) => byId.has(id))
        .slice(0, ctx.itemLimit)
        .map((id) => mapRowToMediaItem(byId.get(id)!));
    await applyJellyfinContentLanguage(ctx.sql, ctx.userId, items);
    const serialized = serializeBaseItems(items);
    await enrichItemsWithMediaSources(ctx.sql, serialized, ctx.apiKey);
    await enrichItemsWithProviderIds(ctx.sql, serialized);
    const playable = dropFilelessPlayables(serialized);
    for (const i of playable) ctx.used.add(i.Id);
    return playable;
}

async function* similarTo(
    ctx: Ctx,
    seeds: RecommendationSeedRow[],
    type: RecommendationType,
    exclude: Set<string>,
): AsyncGenerator<JellyfinRecommendationDto> {
    for (const seed of seeds) {
        const embedding = parseEmbedding(seed.embedding);
        if (!embedding || embedding.length === 0) continue;
        const neighbours = await findSimilarMediaDual(ctx.sql, embedding, {
            // Over-fetch: hydration drops file-less, hidden and already-used rows.
            limit: ctx.itemLimit * 3,
            mediaTypes: ['movie'],
            excludeWatchedForUserId: ctx.userId,
            access: ctx.access,
        });
        const ids = neighbours.map((n) => n.media_uuid).filter((id) => !exclude.has(id));
        const items = await toDtos(ctx, ids);
        if (items.length === 0) continue;
        yield {
            Items: items,
            RecommendationType: type,
            BaselineItemName: seed.title,
            CategoryId: seed.id,
        };
    }
}

async function* withPeople(
    ctx: Ctx,
    names: string[],
    role: 'actor' | 'director',
    exclude: Set<string>,
): AsyncGenerator<JellyfinRecommendationDto> {
    for (const name of names) {
        const ids = await findUnwatchedMoviesWithPerson(ctx.sql, {
            userId: ctx.userId,
            person: name,
            role,
            excludeIds: [...exclude, ...ctx.used],
            limit: ctx.itemLimit,
            access: ctx.access,
        });
        const items = await toDtos(ctx, ids);
        if (items.length === 0) continue;
        yield {
            Items: items,
            RecommendationType:
                role === 'director'
                    ? 'HasDirectorFromRecentlyPlayed'
                    : 'HasActorFromRecentlyPlayed',
            BaselineItemName: name,
            CategoryId: personCategoryId(name),
        };
    }
}

function uniqueNames(lists: string[][]): string[] {
    return [...new Set(lists.flat().filter((n) => n && n.trim()))];
}

function clampInt(raw: string | null, fallback: number, max: number): number {
    const n = parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
}

export async function handleMovieRecommendations(event: RequestEvent): Promise<Response> {
    const { locals, url } = event;
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const categoryLimit = clampInt(getParam(url, 'CategoryLimit'), 5, 20);
    const itemLimit = clampInt(getParam(url, 'ItemLimit'), 8, 50);
    if (categoryLimit === 0 || itemLimit === 0) return json([]);

    try {
        const access = (await buildJellyfinAccessContext(sql, locals.user)).boundary;
        const userId = locals.user.userId;
        const played = await getMovieRecommendationSeeds(sql, {
            userId,
            kind: 'played',
            limit: 7,
            access,
        });
        const playedIds = new Set(played.map((s) => s.id));
        const liked = (
            await getMovieRecommendationSeeds(sql, {
                userId,
                kind: 'liked',
                limit: 10 + played.length,
                access,
            })
        )
            .filter((s) => !playedIds.has(s.id))
            .slice(0, 10);
        const recent = played.slice(0, 6);
        const seedIds = new Set([...playedIds, ...liked.map((s) => s.id)]);

        const ctx: Ctx = {
            sql,
            userId,
            access,
            itemLimit,
            apiKey: getJfToken(locals as unknown as Record<string, unknown>),
            used: new Set(),
        };
        const playedRows = similarTo(
            ctx,
            played.slice(0, categoryLimit),
            'SimilarToRecentlyPlayed',
            seedIds,
        );
        const likedRows = similarTo(
            ctx,
            liked.slice(0, categoryLimit),
            'SimilarToLikedItem',
            seedIds,
        );
        const sources = [
            playedRows,
            playedRows,
            likedRows,
            likedRows,
            withPeople(ctx, uniqueNames(recent.map((s) => s.directors)), 'director', seedIds),
            withPeople(ctx, uniqueNames(recent.map((s) => s.actors)), 'actor', seedIds),
        ];
        const done = new Set<AsyncGenerator<JellyfinRecommendationDto>>();
        const categories: JellyfinRecommendationDto[] = [];
        while (categories.length < categoryLimit && done.size < new Set(sources).size) {
            for (const source of sources) {
                if (done.has(source)) continue;
                const next = await source.next();
                if (next.done) {
                    done.add(source);
                    continue;
                }
                categories.push(next.value);
                if (categories.length >= categoryLimit) break;
            }
        }
        return json(categories);
    } catch (error) {
        logger.error('Movie recommendations failed', error as Error);
        return ApiResponses.error('Failed to get movie recommendations');
    }
}
