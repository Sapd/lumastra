// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types.js';
import { CatalogService } from './catalog.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../tests/integration/helpers/users.js';
import { MediaDetailResponseSchema } from '$lib/server/api/defs/catalog/media-id.js';
import {
    hydrateMediaPreviews,
    type MediaPreviewBatchContext,
} from './media-preview-batch.service.js';

// Own fixtures only: no shared-table truncation while sibling streams run tests.
describe('batch hydration access boundary (seeded PostgreSQL)', () => {
    let sql: postgres.Sql;
    let user: { id: string; username: string };
    let ctx: MediaPreviewBatchContext;
    const allowed = randomUUID();
    const denied = randomUUID();
    const visible = randomUUID();
    const hidden = randomUUID();
    const episode = randomUUID();
    const season = randomUUID();
    const series = randomUUID();
    const adult = randomUUID();
    const externalId = String(50000000 + Math.floor(Math.random() * 10000000));
    const tvdbId = `batch-${randomUUID()}`;
    const allIds = [visible, hidden, episode, season, series, adult];
    beforeAll(async () => {
        sql = getTestDb();
        user = await createTestUser(sql);
        await sql`INSERT INTO library_groups (id, name) VALUES (${allowed}, ${`batch-allowed-${allowed}`}), (${denied}, ${`batch-denied-${denied}`})`;
        await sql`INSERT INTO media_items (id, title, media_type, library_group_id, age_rating)
            VALUES (${visible}, 'Visible movie', 'movie', ${allowed}, 6),
                   (${hidden}, 'Hidden movie', 'movie', ${denied}, 6),
                   (${adult}, 'Adult movie', 'movie', ${allowed}, 18),
                   (${series}, 'Visible series', 'tv', ${allowed}, 6)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, library_group_id)
            VALUES (${season}, 'Season 1', 'season', ${series}, 1, ${allowed})`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, library_group_id)
            VALUES (${episode}, 'Pilot', 'episode', ${season}, 1, 1, ${allowed})`;
        const catalog = new CatalogService(sql, { skipLifecycleHooks: true });
        await catalog.upsertExternalId(visible, {
            provider: 'tmdb',
            id: externalId,
            mediaType: 'movie',
        });
        await catalog.upsertExternalId(series, {
            provider: 'tmdb',
            id: externalId,
            mediaType: 'tv',
        });
        await catalog.upsertExternalId(series, { provider: 'tvdb', id: tvdbId, mediaType: 'tv' });
        ctx = {
            sql,
            surface: 'v1',
            user: { userId: toUserId(user.id), username: user.username } as UserContext,
            access: restrictedAccess({
                deniedGroupIds: [denied],
                maxAgeRating: 12,
                allowUnrated: true,
            }),
        };
    });
    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE id = ${episode}`;
        await sql`DELETE FROM media_items WHERE id = ${season}`;
        await sql`DELETE FROM media_items WHERE id = ANY(${allIds}::uuid[])`;
        await sql`DELETE FROM library_groups WHERE id IN (${allowed}, ${denied})`;
        if (user) {
            await sql`DELETE FROM user_profiles WHERE user_id = ${user.id}`;
            await sql`DELETE FROM users WHERE id = ${user.id}`;
        }
        await closeTestDb();
    });
    it('puts inaccessible and nonexistent UUIDs in the same missing array without metadata', async () => {
        const unknown = randomUUID();
        expect(await hydrateMediaPreviews(ctx, [hidden, unknown, 'invalid'])).toEqual({
            items: [],
            missing: [hidden, unknown, 'invalid'],
        });
        expect(await hydrateMediaPreviews(ctx, [hidden, unknown], { include: 'detail' })).toEqual({
            items: [],
            missing: [hidden, unknown],
        });
    });
    it('resolves typed handles in batch and prefers movies for two-part TMDB handles', async () => {
        const ids = [`tmdb:${externalId}:movie`, `tvdb:${tvdbId}:series`, `tmdb:${externalId}`];
        const result = await hydrateMediaPreviews(ctx, ids);
        expect(result.items.map((item) => item.id)).toEqual([visible, series]);
        expect(result.missing).toEqual([]);
        const untyped = await hydrateMediaPreviews(ctx, [`tmdb:${externalId}`]);
        expect(untyped.items.map((item) => item.id)).toEqual([visible]);
    });
    it('falls back to series when a two-part external handle has no movie', async () => {
        const result = await hydrateMediaPreviews(ctx, [`tvdb:${tvdbId}`]);
        expect(result.items.map((item) => item.id)).toEqual([series]);
        expect(result.missing).toEqual([]);
        const seriesOnlyTmdb = String(Number(externalId) + 10000000);
        // A separate series row: one item keeps a single tmdb id per provider.
        const seriesOnly = randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, library_group_id, age_rating)
            VALUES (${seriesOnly}, 'Series only', 'tv', ${allowed}, 6)`;
        await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(seriesOnly, {
            provider: 'tmdb',
            id: seriesOnlyTmdb,
            mediaType: 'tv',
        });
        try {
            const fallback = await hydrateMediaPreviews(ctx, [`tmdb:${seriesOnlyTmdb}`]);
            expect(fallback.items.map((item) => item.id)).toEqual([seriesOnly]);
            expect(fallback.missing).toEqual([]);
        } finally {
            await sql`DELETE FROM media_items WHERE id = ${seriesOnly}`;
        }
    });
    it('does not fall back past a hidden movie to expose a different series', async () => {
        const collision = String(Number(externalId) + 20000000);
        const catalog = new CatalogService(sql, { skipLifecycleHooks: true });
        await catalog.upsertExternalId(hidden, {
            provider: 'tmdb',
            id: collision,
            mediaType: 'movie',
        });
        await catalog.upsertExternalId(series, {
            provider: 'tmdb',
            id: collision,
            mediaType: 'tv',
        });
        expect(await hydrateMediaPreviews(ctx, [`tmdb:${collision}`])).toEqual({
            items: [],
            missing: [`tmdb:${collision}`],
        });
    });
    it('preserves mixed-kind order, scopes age and library together, and hydrates episode context', async () => {
        const result = await hydrateMediaPreviews(ctx, [
            episode,
            hidden,
            visible,
            adult,
            season,
            series,
            episode,
        ]);
        expect(result.items.map((item) => item.id)).toEqual([episode, visible, season, series]);
        expect(result.items[0]).toMatchObject({
            type: 'episode',
            context: {
                series: { id: series, catalogId: series, title: 'Visible series' },
                seasonNumber: 1,
                episodeNumber: 1,
            },
        });
        expect(result.items.every((item) => /^[a-f0-9]{16}$/.test(item.revision!))).toBe(true);
        expect(result.missing).toEqual([hidden, adult]);
    });
    it('include=detail returns only the visible item in the GET detail shape plus a revision', async () => {
        const result = await hydrateMediaPreviews(ctx, [visible, hidden, adult], {
            include: 'detail',
        });
        expect(result.items.map((item) => item.id)).toEqual([visible]);
        expect(MediaDetailResponseSchema.safeParse(result.items[0]).success).toBe(true);
        expect(result.items[0].revision).toMatch(/^[a-f0-9]{16}$/);
        expect(result.missing).toEqual([hidden, adult]);
    });
});
