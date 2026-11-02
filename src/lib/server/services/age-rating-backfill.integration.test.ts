// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    deriveFromStoredCertifications,
    findCertificationLookupCandidates,
    lookupCertifications,
} from './age-rating-backfill.service.js';
import { updateMediaAgeRating } from '../database/queries/media-upsert.js';

let sql: postgres.Sql;

beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, ['provider_metadata', 'external_ids', 'media_items']);
});

interface ItemOptions {
    type?: 'movie' | 'tv';
    mdblist?: number;
    tmdbId?: string;
    tmdbMeta?: Record<string, unknown>;
    jellyfinMeta?: Record<string, unknown>;
    locked?: boolean;
    hasFiles?: boolean;
}

async function item(title: string, o: ItemOptions = {}): Promise<string> {
    const type = o.type ?? 'movie';
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, year, metadata_locked, has_files)
        VALUES (${title}, ${type}, 'active', 2020, ${o.locked ?? false}, ${o.hasFiles ?? true})
        RETURNING id`;
    const id = row!.id;
    if (o.mdblist !== undefined) await updateMediaAgeRating(sql, id, o.mdblist);
    if (o.tmdbId) {
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                  VALUES (${id}, 'tmdb', ${o.tmdbId}, ${type}, true, 'test')`;
    }
    if (o.tmdbMeta) {
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                  VALUES (${id}, 'tmdb', ${sql.json(o.tmdbMeta as never)})`;
    }
    if (o.jellyfinMeta) {
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                  VALUES (${id}, 'jellyfin', ${sql.json(o.jellyfinMeta as never)})`;
    }
    return id;
}

async function rating(id: string) {
    const [r] = await sql<{ age_rating: number | null; age_rating_source: string | null }[]>`
        SELECT age_rating, age_rating_source FROM media_items WHERE id = ${id}`;
    return r!;
}

describe('phase A: derive from stored certifications', () => {
    it('national wins over MDBList (both directions), tmdb beats jellyfin, the rest is untouched', async () => {
        const stricterMdb = await item('A', { mdblist: 18, tmdbMeta: { certification: 'FSK 12' } });
        const looserMdb = await item('B', { mdblist: 6, jellyfinMeta: { certification: '16' } });
        const both = await item('C', {
            tmdbMeta: { certification: 'PG-13' },
            jellyfinMeta: { certification: 'R' },
        });
        const notRated = await item('D', { mdblist: 14, tmdbMeta: { certification: 'NR' } });
        const alreadyNational = await item('E', { tmdbMeta: { certification: '12' } });
        await sql`UPDATE media_items SET age_rating = 16, age_rating_source = 'national'
                  WHERE id = ${alreadyNational}`;
        const noCert = await item('F', { mdblist: 10 });
        const series = await item('G', { type: 'tv', tmdbMeta: { certification: 'TV-MA' } });

        const first = await deriveFromStoredCertifications(sql);
        expect(first.written).toBe(4);

        expect(await rating(stricterMdb)).toEqual({ age_rating: 12, age_rating_source: 'national' });
        expect(await rating(looserMdb)).toEqual({ age_rating: 16, age_rating_source: 'national' });
        expect(await rating(both)).toEqual({ age_rating: 13, age_rating_source: 'national' });
        expect(await rating(series)).toEqual({ age_rating: 18, age_rating_source: 'national' });
        expect(await rating(notRated)).toEqual({ age_rating: 14, age_rating_source: 'mdblist' });
        expect(await rating(alreadyNational)).toEqual({
            age_rating: 16,
            age_rating_source: 'national',
        });
        expect(await rating(noCert)).toEqual({ age_rating: 10, age_rating_source: 'mdblist' });

        // Idempotent: a second run writes nothing new.
        const second = await deriveFromStoredCertifications(sql, { chunk: 1 });
        expect(second.written).toBe(0);
    });
});

describe('phase B: TMDB lookups', () => {
    const deNinety = {
        release_dates: {
            results: [
                { iso_3166_1: 'DE', release_dates: [{ certification: '16', type: 3 }] },
                { iso_3166_1: 'US', release_dates: [{ certification: 'R', type: 3 }] },
            ],
        },
    };

    it('selects unchecked titles only; skips checked and recently failed ones, includes locked', async () => {
        const fresh = await item('fresh', { tmdbId: '1' });
        const noRow = await item('noRow', { tmdbId: '2', hasFiles: false });
        await item('checked', { tmdbId: '3', tmdbMeta: { age_rating_country_checked: 'DE' } });
        const otherCountry = await item('other', {
            tmdbId: '4',
            tmdbMeta: { age_rating_country_checked: 'US' },
        });
        const locked = await item('locked', { tmdbId: '5', locked: true });
        await item('failed', {
            tmdbId: '6',
            tmdbMeta: { age_rating_lookup_error_at: new Date().toISOString() },
        });
        const oldFailure = await item('oldFailure', {
            tmdbId: '7',
            tmdbMeta: { age_rating_lookup_error_at: '2020-01-01T00:00:00Z' },
        });
        await item('noTmdbId', {});

        const ids = (await findCertificationLookupCandidates(sql, 'DE', 50)).map((c) => c.media_id);
        // Locked titles are included: the age rating is safety data, not user-edited metadata.
        expect(new Set(ids)).toEqual(new Set([fresh, noRow, otherCountry, oldFailure, locked]));
        // Library titles come first.
        expect(ids.indexOf(noRow)).toBe(ids.length - 1);
        expect(await findCertificationLookupCandidates(sql, 'DE', 2)).toHaveLength(2);
    });

    it('writes the national age, stamps the row, and converges (second pass finds nothing)', async () => {
        const mdb = await item('mdb', { tmdbId: '10', mdblist: 6 });
        const none = await item('none', { tmdbId: '11' });
        const gone = await item('gone', { tmdbId: '12' });
        const broken = await item('broken', { tmdbId: '13' });

        const candidates = await findCertificationLookupCandidates(sql, 'DE', 50);
        const result = await lookupCertifications(sql, candidates, 'DE', {
            fetchDetail: async (c) => {
                if (c.media_id === mdb) return deNinety;
                if (c.media_id === none) return { release_dates: { results: [] } };
                if (c.media_id === gone) throw Object.assign(new Error('404'), { notFound: true });
                throw new Error('boom');
            },
            isNotFound: (e) => (e as { notFound?: boolean }).notFound === true,
        });

        expect(result).toMatchObject({ written: 1, noCertification: 1, notFound: 1, failed: 1 });
        expect(await rating(mdb)).toEqual({ age_rating: 16, age_rating_source: 'national' });
        expect(await rating(none)).toEqual({ age_rating: null, age_rating_source: null });

        const [meta] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${mdb} AND provider = 'tmdb'`;
        expect(meta!.metadata).toMatchObject({
            certification: '16',
            certification_country: 'DE',
            age_rating_country_checked: 'DE',
        });

        // Only the transient failure is left, and it waits out its retry window.
        expect(await findCertificationLookupCandidates(sql, 'DE', 50)).toEqual([]);
        // A different country makes every title a candidate again (except the failure window).
        const again = (await findCertificationLookupCandidates(sql, 'GB', 50)).map((c) => c.media_id);
        expect(new Set(again)).toEqual(new Set([mdb, none, gone]));
        expect(again).not.toContain(broken);
    });
});

describe('country change: stale national ratings', () => {
    it('resets the source of a rating that came from another country when the new country and the US have nothing, so MDBList can fill; locked titles included', async () => {
        const staleMeta = {
            certification: 'PG',
            certification_country: 'US',
            age_rating_country_checked: 'US',
        };
        const stale = await item('stale', { tmdbId: '20', tmdbMeta: staleMeta });
        const lockedStale = await item('lockedStale', {
            tmdbId: '21',
            locked: true,
            tmdbMeta: staleMeta,
        });
        for (const id of [stale, lockedStale]) {
            await sql`UPDATE media_items SET age_rating = 8, age_rating_source = 'national'
                      WHERE id = ${id}`;
        }
        // Same country, TMDB has nothing now: keep the rating (not a country change).
        const sameCountry = await item('sameCountry', {
            tmdbId: '22',
            tmdbMeta: { certification_country: 'DE', age_rating_country_checked: 'GB' },
        });
        await sql`UPDATE media_items SET age_rating = 12, age_rating_source = 'national'
                  WHERE id = ${sameCountry}`;

        const candidates = await findCertificationLookupCandidates(sql, 'DE', 50);
        expect(new Set(candidates.map((c) => c.media_id))).toEqual(
            new Set([stale, lockedStale, sameCountry]),
        );
        await lookupCertifications(sql, candidates, 'DE', {
            fetchDetail: async () => ({ release_dates: { results: [] } }),
            isNotFound: () => false,
        });

        for (const id of [stale, lockedStale]) {
            expect(await rating(id)).toEqual({ age_rating: 8, age_rating_source: null });
            const [meta] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${id} AND provider = 'tmdb'`;
            expect(meta!.metadata.certification).toBeNull();
            expect(meta!.metadata.age_rating_country_checked).toBe('DE');
        }
        expect(await rating(sameCountry)).toEqual({ age_rating: 12, age_rating_source: 'national' });

        // MDBList can now fill, and the stale certification is not re-derived by phase A.
        await updateMediaAgeRating(sql, stale, 12);
        expect(await rating(stale)).toEqual({ age_rating: 12, age_rating_source: 'mdblist' });
        await deriveFromStoredCertifications(sql, { country: 'DE' });
        expect(await rating(stale)).toEqual({ age_rating: 12, age_rating_source: 'mdblist' });
    });

    it('phase A ignores a stored TMDB certification that was looked up for another country', async () => {
        const otherCountry = await item('other', {
            mdblist: 18,
            tmdbMeta: {
                certification: 'PG',
                certification_country: 'US',
                age_rating_country_checked: 'US',
            },
        });
        const legacy = await item('legacy', { mdblist: 18, tmdbMeta: { certification: '12' } });
        await deriveFromStoredCertifications(sql, { country: 'DE' });
        expect(await rating(otherCountry)).toEqual({ age_rating: 18, age_rating_source: 'mdblist' });
        // No recorded country (legacy rows): still used.
        expect(await rating(legacy)).toEqual({ age_rating: 12, age_rating_source: 'national' });
    });
});
