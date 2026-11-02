// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fresh install, 2026-09-29: the hero and /api/recommendations rows showed no
 * description although media_items.overview and the 'tmdb' provider row were
 * full. The runtime aggregation table comes from provider MANIFESTS, which name
 * providers by definition id ('tmdb-metadata-provider'), while source rows are
 * stored under 'tmdb' — so every manifest-declared field (overview, poster,
 * backdrop, vote_average, runtime, …) was left out of 'aggregated', and the
 * metadata lateral join reads 'aggregated' first. Other tests aggregate on the
 * default table (no plugins loaded), so this one installs the real manifests.
 *
 * Requires the integration database:
 *   npm run test:integration -- src/lib/server/database/queries/metadata-aggregation-manifest-chain.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import { tmdbProvider } from '../../tasks/builtin/native/providers/tmdb.js';
import { mdblistProvider } from '../../tasks/builtin/native/providers/mdblist.js';
import { buildFieldAuthorityConfigFromDefinitions } from '../../plugins/runtime/field-authority-loader.js';
import {
    aggregateMetadataForMedia,
    batchAggregateMetadata,
    resetFieldAuthorityCache,
    setEffectiveFieldPriorities,
} from './metadata-aggregation.queries.js';
import { getQualityLibraryMedia } from './hero-fallback.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';

/** What the scan path stores on the 'tmdb' row (canonical overlay included). */
const TMDB_ROW = {
    title: 'Night of the Living Dead',
    overview: 'A ragtag group barricade themselves in an old farmhouse.',
    poster_path: '/poster.jpg',
    backdrop_path: '/backdrop.jpg',
    logo_path: '/logo.png',
    vote_average: 7.5,
    vote_count: 2100,
    popularity: 18.4,
    runtime_minutes: 96,
    tagline: 'They keep coming back',
    genres: [{ id: 27, name: 'Horror' }],
    genre_slugs: ['horror'],
    keyword_slugs: ['zombie'],
    tmdb_keyword_ids: [12377],
    actors: ['Duane Jones'],
    cast: [{ name: 'Duane Jones', character: 'Ben', person_id: '4167' }],
};

const MANIFEST_FIELDS = [
    'overview',
    'poster_path',
    'backdrop_path',
    'vote_average',
    'runtime_minutes',
] as const;

describe('aggregation under the provider manifests (fresh install)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        resetFieldAuthorityCache();
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['provider_metadata', 'external_ids', 'media_items']);
        resetFieldAuthorityCache();
        // Exactly what loader.ts's rebuildFieldAuthorityPriorities installs at
        // boot, with no operator plugin_settings (a fresh install).
        const config = buildFieldAuthorityConfigFromDefinitions(
            [tmdbProvider, mdblistProvider],
            new Map(),
        );
        setEffectiveFieldPriorities(config.defaultPriorities);
    });

    async function insertItem(opts: { locked?: boolean } = {}): Promise<string> {
        const item = createTestMediaItem({ media_type: 'movie', has_files: true });
        await insertTestMediaItem(sql, item);
        if (opts.locked) {
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${item.id}::uuid`;
        }
        return item.id;
    }

    async function insertProviderRow(
        mediaId: string,
        provider: string,
        metadata: Record<string, unknown>,
    ): Promise<void> {
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
            VALUES (${mediaId}::uuid, ${provider}, ${sql.json(metadata as Record<string, never>)}, NOW(), NOW())
        `;
    }

    async function aggregatedRow(
        mediaId: string,
    ): Promise<{ metadata: Record<string, unknown>; field_sources: Record<string, string> }> {
        const [row] = await sql<
            { metadata: Record<string, unknown>; field_sources: Record<string, string> }[]
        >`
            SELECT metadata, field_sources FROM provider_metadata
            WHERE media_id = ${mediaId}::uuid AND provider = 'aggregated'
        `;
        return row;
    }

    it('batch aggregation (cast/keyword backfill, missing-metadata sync) writes the manifest-declared fields', async () => {
        const id = await insertItem();
        await insertProviderRow(id, 'tmdb', TMDB_ROW);

        await batchAggregateMetadata(sql, [id]);

        const { metadata, field_sources } = await aggregatedRow(id);
        for (const field of MANIFEST_FIELDS) {
            expect(metadata[field], field).toEqual(TMDB_ROW[field]);
            expect(field_sources[field], field).toBe('tmdb');
        }
        // The default-only fields still come through.
        expect(metadata.cast).toEqual(TMDB_ROW.cast);
        expect(metadata.genre_slugs).toEqual(['horror']);
    });

    it('per-item aggregation (tmdb metadata sync) writes the manifest-declared fields', async () => {
        const id = await insertItem();
        await insertProviderRow(id, 'tmdb', TMDB_ROW);

        await aggregateMetadataForMedia(sql, id);

        const { metadata } = await aggregatedRow(id);
        for (const field of MANIFEST_FIELDS) {
            expect(metadata[field], field).toEqual(TMDB_ROW[field]);
        }
    });

    it('a manifest-declared field keeps its default fallback when tmdb lacks it', async () => {
        const id = await insertItem();
        const { overview: _omit, ...withoutOverview } = TMDB_ROW;
        await insertProviderRow(id, 'tmdb', withoutOverview);
        await insertProviderRow(id, 'jellyfin', { overview: 'From the media server.' });

        await batchAggregateMetadata(sql, [id]);

        const { metadata, field_sources } = await aggregatedRow(id);
        expect(metadata.overview).toBe('From the media server.');
        expect(field_sources.overview).toBe('jellyfin');
    });

    it('the hero / recommendations reader serves overview, artwork, rating and runtime', async () => {
        const id = await insertItem();
        await insertProviderRow(id, 'tmdb', TMDB_ROW);
        await batchAggregateMetadata(sql, [id]);

        const [row] = await getQualityLibraryMedia(sql, {
            mediaType: 'movie',
            limit: 5,
            access: unrestrictedAccess(),
        });

        expect(row.internal_id).toBe(id);
        expect(row.overview).toBe(TMDB_ROW.overview);
        expect(row.poster_path).toBe(TMDB_ROW.poster_path);
        expect(row.backdrop_path).toBe(TMDB_ROW.backdrop_path);
        expect(row.tmdb_rating).toBe(TMDB_ROW.vote_average);
        expect(row.runtime_minutes).toBe(TMDB_ROW.runtime_minutes);
    });
});
