// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * People and studios on /j against the test database: BaseItemDto.People /
 * Studios / Tags, /Persons, /Persons/{name}, /Studios, /Studios/{name},
 * /Items/{personId|studioId} and the PersonIds / Person / PersonTypes /
 * StudioIds / Studios filters on /Items. withJellyfinAuth is bypassed; the
 * real handlers and queries run. Under test above all: a person or studio
 * credited only on a title the user cannot see does not exist for that user.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import {
    seedEpisodeExternalSrt,
    seedMovieEmbeddedSubs,
    seedProviderMetadata,
} from '../../../../../tests/jellyfin-contract/seed.js';
import { verifyPersonImageTag } from './people-studios';
import { upsertMediaMetadata } from '$lib/server/database/queries/media-upsert.js';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/services/image-proxy', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/services/image-proxy')>();
    return {
        ...mod,
        getImageProxyService: () => ({
            getPersonImage: async (id: string) => ({
                buffer: Buffer.from(`headshot-${id}`),
                contentType: 'image/jpeg',
                cacheControl: 'public, max-age=60',
            }),
        }),
    };
});

vi.mock('$lib/server/services/person.service', () => ({
    fetchPersonBio: vi.fn(async (id: number) =>
        id === 101
            ? {
                  name: 'Ana Actor',
                  biography: 'Ana is an actor.',
                  birthday: '1980-02-03',
                  placeOfBirth: 'Vienna, Austria',
              }
            : null,
    ),
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const R = '../../../../routes/(proprietary)/j';

interface TestUser {
    userId: string;
    userGroups?: string[];
    maxAgeRating?: number | null;
}

function event(path: string, params: Record<string, string>, user: TestUser): RequestEvent {
    const url = new URL(`http://localhost/j${path}`);
    const restricted = user.maxAgeRating != null;
    return {
        url,
        request: new Request(url),
        locals: {
            user: {
                username: 'people-test',
                userId: toUserId(user.userId),
                groups: (user.userGroups ?? []).join(','),
                userGroups: user.userGroups ?? [],
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                maxAgeRating: user.maxAgeRating ?? null,
                isAgeRestricted: restricted,
                isModerator: false,
                liveTvPriority: 'low',
            },
        },
        params,
        route: { id: null },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as RequestEvent;
}

type Handler = (e: RequestEvent) => Promise<Response>;
interface Dto {
    Id: string;
    Name: string;
    Type: string;
    Role?: string;
    PrimaryImageTag?: string;
    People?: Dto[];
    Studios?: { Name: string; Id: string }[];
    Tags?: string[];
    MovieCount?: number;
    SeriesCount?: number;
    Overview?: string;
    PremiereDate?: string;
    ProductionLocations?: string[];
    ImageTags?: Record<string, string>;
}
interface Page {
    Items: Dto[];
    TotalRecordCount: number;
}

async function call<T = Dto>(
    handler: unknown,
    path: string,
    params: Record<string, string>,
    user: TestUser,
): Promise<{ status: number; body: T }> {
    const res = await (handler as Handler)(event(path, params, user));
    return { status: res.status, body: (await res.json()) as T };
}

describe.runIf(RUN)('/j people and studios', () => {
    let sql: postgres.Sql;
    let deniedGroupId: string;
    const kids: TestUser = { userId: randomUUID(), userGroups: ['kids'] };
    const adults: TestUser = { userId: randomUUID(), userGroups: ['adults'] };
    const age12: TestUser = { userId: randomUUID(), userGroups: ['adults'], maxAgeRating: 12 };

    let movie: string;
    let hidden: string;
    let series: string;
    let episode: string;
    const key = async (fn: 'person_key' | 'studio_key', name: string): Promise<string> => {
        const [r] =
            fn === 'person_key'
                ? await sql<{ id: string }[]>`SELECT person_key(${name})::text AS id`
                : await sql<{ id: string }[]>`SELECT studio_key(${name})::text AS id`;
        return r.id;
    };

    beforeAll(async () => {
        sql = getTestDb();
        deniedGroupId = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'People Adults')`;
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: deniedGroupId,
            allowedGroups: ['adults'],
        });
        invalidateLibraryGroupPermissionsCache();
    });

    afterAll(async () => {
        await deleteLibraryGroupPermission(sql, deniedGroupId);
        await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
        invalidateLibraryGroupPermissionsCache();
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        for (const u of [kids, adults, age12]) await ensureTestUser(sql, u.userId);

        movie = (await seedMovieEmbeddedSubs(sql)).itemId;
        await sql`UPDATE media_items SET title = 'Heist Movie', age_rating = 6 WHERE id = ${movie}::uuid`;
        await seedProviderMetadata(sql, movie, {
            cast: [
                { name: 'Ana Actor', character: 'Hero', person_id: '101', has_profile: true },
                { name: 'Ben Actor', character: 'Sidekick', person_id: '102', has_profile: false },
            ],
            actors: ['Ana Actor', 'Ben Actor'],
            directors: ['Dee Director'],
            writers: ['Wanda Writer', 'Dee Director'],
            producers: ['Pat Producer'],
            production_companies: ['Acme Pictures'],
            keywords: ['space', 'heist'],
        });

        const h = await seedMovieEmbeddedSubs(sql);
        hidden = h.itemId;
        await sql`UPDATE media_items SET title = 'Hidden Movie', age_rating = 6 WHERE id = ${hidden}::uuid`;
        await sql`UPDATE media_files SET library_group_id = ${deniedGroupId}::uuid WHERE id = ${h.fileId}::uuid`;
        await seedProviderMetadata(sql, hidden, {
            cast: [{ name: 'Hank Hidden', character: 'Spy', person_id: '201' }],
            actors: ['Hank Hidden', 'Ana Actor'],
            production_companies: [{ name: 'Secret Studio' }],
        });

        const s = await seedEpisodeExternalSrt(sql);
        series = s.seriesId;
        episode = s.itemId;
        await sql`UPDATE media_items SET age_rating = 6 WHERE id IN (${series}::uuid, ${s.seasonId}::uuid, ${episode}::uuid)`;
        await seedProviderMetadata(sql, series, {
            cast: [{ name: 'Ana Actor', character: 'Anna', person_id: '101' }],
            actors: ['Ana Actor'],
            networks: ['Net One'],
        });
    });

    it('item detail carries People in billing order, then crew; Studios; Tags', async () => {
        const { GET } = await import(`${R}/Items/[itemId]/+server`);
        const { status, body } = await call(GET, '', { itemId: movie }, kids);
        expect(status).toBe(200);
        expect(body.People!.map((p) => [p.Name, p.Type, p.Role])).toEqual([
            ['Ana Actor', 'Actor', 'Hero'],
            ['Ben Actor', 'Actor', 'Sidekick'],
            ['Dee Director', 'Director', undefined],
            ['Wanda Writer', 'Writer', undefined],
            ['Dee Director', 'Writer', undefined],
            ['Pat Producer', 'Producer', undefined],
        ]);
        const ana = body.People![0];
        expect(ana.Id).toBe(await key('person_key', 'Ana Actor'));
        // A headshot tag only where the provider has one; it names TMDB 101.
        expect(verifyPersonImageTag(ana.Id, ana.PrimaryImageTag)).toBe(101);
        expect(body.People![1].PrimaryImageTag).toBeUndefined();
        expect(body.People![2].PrimaryImageTag).toBeUndefined();
        expect(body.Studios).toEqual([
            { Name: 'Acme Pictures', Id: await key('studio_key', 'Acme Pictures') },
        ]);
        expect(body.Tags).toEqual(['heist', 'space']);
    });

    it('an episode shows its series cast; the legacy route carries the same fields', async () => {
        const { GET } = await import(`${R}/Items/[itemId]/+server`);
        const ep = await call(GET, '', { itemId: episode }, kids);
        expect(ep.body.People!.map((p) => [p.Name, p.Role])).toEqual([['Ana Actor', 'Anna']]);
        expect(ep.body.Studios).toBeUndefined();

        const { GET: legacy } = await import(`${R}/Users/[userId]/Items/[itemId]/+server`);
        const l = await call(legacy, '', { userId: kids.userId, itemId: series }, kids);
        expect(l.status).toBe(200);
        expect(l.body.Studios!.map((s) => s.Name)).toEqual(['Net One']);
    });

    it('lists carry People / Studios / Tags only when Fields asks for them', async () => {
        const { GET } = await import(`${R}/Items/+server`);
        const plain = await call<Page>(
            GET,
            `/Items?Recursive=true&IncludeItemTypes=Movie`,
            {},
            kids,
        );
        expect(plain.body.Items[0].People).toBeUndefined();
        const withFields = await call<Page>(
            GET,
            `/Items?Recursive=true&IncludeItemTypes=Movie&Fields=People,Studios`,
            {},
            kids,
        );
        expect(withFields.body.Items[0].People!.length).toBe(6);
        expect(withFields.body.Items[0].Studios!.map((s) => s.Name)).toEqual(['Acme Pictures']);
        expect(withFields.body.Items[0].Tags).toBeUndefined();
    });

    it('PersonIds / Person / PersonTypes filter /Items, access-scoped', async () => {
        const { GET } = await import(`${R}/Items/+server`);
        const ana = await key('person_key', 'Ana Actor');
        const names = async (path: string, user: TestUser = kids): Promise<string[]> =>
            (await call<Page>(GET, path, {}, user)).body.Items.map((i) => i.Name).sort();

        expect(await names(`/Items?Recursive=true&PersonIds=${ana}`)).toEqual([
            'Contract Series',
            'Heist Movie',
        ]);
        expect(await names(`/Items?Recursive=true&PersonIds=${ana}`, adults)).toEqual([
            'Contract Series',
            'Heist Movie',
            'Hidden Movie',
        ]);
        expect(
            await names(`/Items?Recursive=true&PersonIds=${ana}&IncludeItemTypes=Series`),
        ).toEqual(['Contract Series']);
        expect(await names(`/Items?Recursive=true&PersonIds=${ana}&PersonTypes=Director`)).toEqual(
            [],
        );
        // Dashless ids, a writer (media_crew) and a name.
        const wanda = (await key('person_key', 'Wanda Writer')).replace(/-/g, '');
        expect(await names(`/Items?Recursive=true&PersonIds=${wanda}`)).toEqual(['Heist Movie']);
        expect(await names(`/Items?Recursive=true&Person=dee%20director`)).toEqual(['Heist Movie']);
        // A malformed id matches nothing; it does not drop the filter.
        expect(await names(`/Items?Recursive=true&PersonIds=nope`)).toEqual([]);
        // The hidden-only person finds nothing for kids.
        const hank = await key('person_key', 'Hank Hidden');
        expect(await names(`/Items?Recursive=true&PersonIds=${hank}`)).toEqual([]);
    });

    it('StudioIds / Studios filter /Items, access-scoped', async () => {
        const { GET } = await import(`${R}/Items/+server`);
        const names = async (path: string, user: TestUser = kids): Promise<string[]> =>
            (await call<Page>(GET, path, {}, user)).body.Items.map((i) => i.Name).sort();
        const acme = await key('studio_key', 'Acme Pictures');
        expect(await names(`/Items?Recursive=true&StudioIds=${acme}`)).toEqual(['Heist Movie']);
        expect(await names(`/Items?Recursive=true&Studios=Net%20One|Nobody`)).toEqual([
            'Contract Series',
        ]);
        const secret = await key('studio_key', 'Secret Studio');
        expect(await names(`/Items?Recursive=true&StudioIds=${secret}`)).toEqual([]);
        expect(await names(`/Items?Recursive=true&StudioIds=${secret}`, adults)).toEqual([
            'Hidden Movie',
        ]);
    });

    it('a cast member billed below the flat actors list still resolves', async () => {
        // Ingest keeps 20 structured cast members but only 10 flat `actors`.
        await sql`
            UPDATE provider_metadata
            SET metadata = jsonb_set(metadata, '{cast}', metadata->'cast' || '[{"name": "Zed Extra", "character": "Guard", "person_id": "999"}]')
            WHERE media_id = ${movie}::uuid`;
        const zed = await key('person_key', 'Zed Extra');
        const { GET } = await import(`${R}/Items/[itemId]/+server`);
        expect((await call(GET, '', { itemId: zed }, kids)).body).toMatchObject({
            Name: 'Zed Extra',
            Type: 'Person',
            MovieCount: 1,
        });
        const { GET: items } = await import(`${R}/Items/+server`);
        const r = await call<Page>(items, `/Items?Recursive=true&PersonIds=${zed}`, {}, kids);
        expect(r.body.Items.map((i) => i.Name)).toEqual(['Heist Movie']);
    });

    it('/Persons lists only people of visible titles, with counts and filters', async () => {
        const { GET } = await import(`${R}/Persons/+server`);
        const kidsList = await call<Page>(GET, '/Persons', {}, kids);
        expect(kidsList.status).toBe(200);
        const byName = new Map(kidsList.body.Items.map((p) => [p.Name, p]));
        expect([...byName.keys()]).toEqual([
            'Ana Actor',
            'Ben Actor',
            'Dee Director',
            'Pat Producer',
            'Wanda Writer',
        ]);
        expect(kidsList.body.TotalRecordCount).toBe(5);
        expect(byName.get('Ana Actor')).toMatchObject({
            Type: 'Person',
            MovieCount: 1,
            SeriesCount: 1,
        });

        const adultList = await call<Page>(GET, '/Persons', {}, adults);
        expect(adultList.body.Items.map((p) => p.Name)).toContain('Hank Hidden');

        const writers = await call<Page>(GET, '/Persons?personTypes=Writer', {}, kids);
        expect(writers.body.Items.map((p) => p.Name)).toEqual(['Dee Director', 'Wanda Writer']);
        const noActors = await call<Page>(
            GET,
            '/Persons?excludePersonTypes=Actor,Producer,Writer',
            {},
            kids,
        );
        expect(noActors.body.Items.map((p) => p.Name)).toEqual(['Dee Director']);
        const search = await call<Page>(GET, '/Persons?searchTerm=WAN', {}, kids);
        expect(search.body.Items.map((p) => p.Name)).toEqual(['Wanda Writer']);
        const paged = await call<Page>(GET, '/Persons?startIndex=1&limit=2', {}, kids);
        expect(paged.body.Items.map((p) => p.Name)).toEqual(['Ben Actor', 'Dee Director']);
        expect(paged.body.TotalRecordCount).toBe(5);
        const past = await call<Page>(GET, '/Persons?startIndex=50', {}, kids);
        expect(past.body).toMatchObject({ Items: [], TotalRecordCount: 5 });
        const countOnly = await call<Page>(GET, '/Persons?limit=0', {}, kids);
        expect(countOnly.body).toMatchObject({ Items: [], TotalRecordCount: 5 });
        // Headshot tags on list rows too (Ana has one, Ben's provider has none).
        expect(byName.get('Ana Actor')!.ImageTags!.Primary).toBeDefined();
        expect(byName.get('Ben Actor')!.ImageTags).toEqual({});
        const startsWith = await call<Page>(GET, '/Persons?nameStartsWith=d', {}, kids);
        expect(startsWith.body.Items.map((p) => p.Name)).toEqual(['Dee Director']);
        const fav = await call<Page>(GET, '/Persons?isFavorite=true', {}, kids);
        expect(fav.body.Items).toEqual([]);
        const guest = await call<Page>(GET, '/Persons?personTypes=GuestStar', {}, kids);
        expect(guest.body.Items).toEqual([]);
    });

    it('/Persons?appearsInItemId keeps billing order and the access gate', async () => {
        const { GET } = await import(`${R}/Persons/+server`);
        const r = await call<Page>(GET, `/Persons?appearsInItemId=${movie}`, {}, kids);
        expect(r.body.Items.map((p) => p.Name)).toEqual([
            'Ana Actor',
            'Ben Actor',
            'Dee Director',
            'Wanda Writer',
            'Pat Producer',
        ]);
        expect(r.body.Items[0].ImageTags!.Primary).toBeDefined();
        const denied = await call<Page>(GET, `/Persons?appearsInItemId=${hidden}`, {}, kids);
        expect(denied.body).toMatchObject({ Items: [], TotalRecordCount: 0 });
    });

    it('/Persons/{name} and /Items/{personId}: 404 unless a visible title credits them', async () => {
        const { GET: byName } = await import(`${R}/Persons/[name]/+server`);
        const ok = await call(byName, '', { name: 'ana actor' }, kids);
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({
            Name: 'Ana Actor',
            Type: 'Person',
            Overview: 'Ana is an actor.',
            PremiereDate: '1980-02-03T00:00:00.0000000Z',
            ProductionLocations: ['Vienna, Austria'],
            MovieCount: 1,
            SeriesCount: 1,
        });
        expect((await call(byName, '', { name: 'Hank Hidden' }, kids)).status).toBe(404);
        expect((await call(byName, '', { name: 'Hank Hidden' }, adults)).status).toBe(200);
        expect((await call(byName, '', { name: 'Nobody At All' }, adults)).status).toBe(404);

        const { GET: item } = await import(`${R}/Items/[itemId]/+server`);
        const ana = await key('person_key', 'Ana Actor');
        const viaItems = await call(item, '', { itemId: ana }, age12);
        expect(viaItems.status).toBe(200);
        expect(viaItems.body).toMatchObject({ Id: ana, Type: 'Person' });
        const hank = await key('person_key', 'Hank Hidden');
        expect((await call(item, '', { itemId: hank }, kids)).status).toBe(404);

        const { GET: legacy } = await import(`${R}/Users/[userId]/Items/[itemId]/+server`);
        const l = await call(legacy, '', { userId: kids.userId, itemId: ana }, kids);
        expect(l.body).toMatchObject({ Id: ana, Type: 'Person' });
    });

    it('/Persons/{name}/Images/Primary: the headshot for a visible person, else 404', async () => {
        const { GET } = await import(`${R}/Persons/[name]/Images/[imageType]/+server`);
        const { GET: indexed } = await import(
            `${R}/Persons/[name]/Images/[imageType]/[imageIndex]/+server`
        );
        const img = (params: Record<string, string>, user: TestUser): Promise<Response> =>
            (GET as Handler)(event('', params, user));
        const ok = await img({ name: 'Ana Actor', imageType: 'Primary' }, kids);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe('headshot-101');
        // Ben's provider has no headshot; Hank is only on a hidden title.
        expect((await img({ name: 'Ben Actor', imageType: 'Primary' }, kids)).status).toBe(404);
        expect((await img({ name: 'Hank Hidden', imageType: 'Primary' }, kids)).status).toBe(404);
        expect((await img({ name: 'Ana Actor', imageType: 'Backdrop' }, kids)).status).toBe(404);
        const idx = (imageIndex: string): Promise<Response> =>
            (indexed as Handler)(
                event('', { name: 'Ana Actor', imageType: 'Primary', imageIndex }, kids),
            );
        expect((await idx('0')).status).toBe(200);
        expect((await idx('1')).status).toBe(404);
        // ApiResponses.badRequest: the project's validation_failed (422).
        expect((await idx('x')).status).toBe(422);
    });

    it('an age limit hides people credited only above it', async () => {
        await sql`UPDATE media_items SET age_rating = 18 WHERE id IN (${movie}::uuid, ${hidden}::uuid)`;
        const { GET } = await import(`${R}/Persons/+server`);
        const r = await call<Page>(GET, '/Persons', {}, age12);
        // Ana is still credited on the series; the movie's crew is gone.
        expect(r.body.Items.map((p) => p.Name)).toEqual(['Ana Actor']);
        expect(r.body.Items[0]).toMatchObject({ MovieCount: 0, SeriesCount: 1 });
    });

    it('/Studios and /Studios/{name} / /Items/{studioId}, access-scoped', async () => {
        const { GET } = await import(`${R}/Studios/+server`);
        const all = await call<Page>(GET, '/Studios', {}, kids);
        expect(all.body.Items.map((s) => [s.Name, s.Type, s.MovieCount, s.SeriesCount])).toEqual([
            ['Acme Pictures', 'Studio', 1, 0],
            ['Net One', 'Studio', 0, 1],
        ]);
        const series = await call<Page>(GET, '/Studios?IncludeItemTypes=Series', {}, kids);
        expect(series.body.Items.map((s) => s.Name)).toEqual(['Net One']);
        const adultsAll = await call<Page>(GET, '/Studios?searchTerm=secret', {}, adults);
        expect(adultsAll.body.Items.map((s) => s.Name)).toEqual(['Secret Studio']);

        const { GET: byName } = await import(`${R}/Studios/[name]/+server`);
        expect((await call(byName, '', { name: 'Secret Studio' }, kids)).status).toBe(404);
        expect((await call(byName, '', { name: 'secret studio' }, adults)).body).toMatchObject({
            Name: 'Secret Studio',
            Type: 'Studio',
        });

        const { GET: item } = await import(`${R}/Items/[itemId]/+server`);
        const acme = await key('studio_key', 'Acme Pictures');
        expect((await call(item, '', { itemId: acme }, kids)).body).toMatchObject({
            Id: acme,
            Type: 'Studio',
        });
        const secret = await key('studio_key', 'Secret Studio');
        expect((await call(item, '', { itemId: secret }, kids)).status).toBe(404);
    });

    it('media_credits follows provider_metadata writes, re-keys and deletes', async () => {
        const crew = async (): Promise<string[]> =>
            (
                await sql<{ r: string }[]>`
                    SELECT role || ':' || name || ':' || COALESCE(provider_person_id, '-') AS r
                    FROM media_credits
                    WHERE media_id = ${movie}::uuid AND role <> 'actor' ORDER BY 1`
            ).map((x) => x.r);
        expect(await crew()).toEqual([
            'producer:Pat Producer:-',
            'studio:Acme Pictures:-',
            'writer:Dee Director:-',
            'writer:Wanda Writer:-',
        ]);
        const [ana] = await sql<{ provider_person_id: string; has_profile: boolean }[]>`
            SELECT provider_person_id, has_profile FROM media_credits
            WHERE media_id = ${movie}::uuid AND role = 'actor' AND name = 'Ana Actor'`;
        expect(ana).toEqual({ provider_person_id: '101', has_profile: true });
        await sql`
            UPDATE provider_metadata
            SET metadata = jsonb_set(metadata, '{writers}', '["  Wanda Writer ", "New Writer"]')
                - 'producers'
            WHERE media_id = ${movie}::uuid`;
        expect(await crew()).toEqual([
            'studio:Acme Pictures:-',
            'writer:New Writer:-',
            'writer:Wanda Writer:-',
        ]);
        // Re-keyed to another provider: nothing stays behind under the old one.
        await sql`UPDATE provider_metadata SET provider = 'aggregated' WHERE media_id = ${movie}::uuid`;
        const [{ n }] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM media_credits
            WHERE media_id = ${movie}::uuid AND source = 'tmdb'`;
        expect(n).toBe(0);
        await sql`DELETE FROM provider_metadata WHERE media_id = ${movie}::uuid`;
        expect(await crew()).toEqual([]);
    });

    it('the PersonIds filter is index-backed', async () => {
        const ana = await key('person_key', 'Ana Actor');
        const plan = await sql.begin(async (tx) => {
            await tx`SET LOCAL enable_seqscan = off`;
            return tx<{ 'QUERY PLAN': string }[]>`
                EXPLAIN SELECT media_id FROM media_people WHERE person_key(name) = ANY(${[ana]}::uuid[])
                UNION ALL
                SELECT media_id FROM media_credits
                WHERE role <> 'studio' AND person_key(name) = ANY(${[ana]}::uuid[])
                UNION ALL
                SELECT media_id FROM media_credits
                WHERE role = 'studio' AND studio_key(name) = ANY(${[ana]}::uuid[])
            `;
        });
        const text = plan.map((r) => r['QUERY PLAN']).join('\n');
        expect(text).toMatch(/idx_media_people_person_key/);
        expect(text).toMatch(/idx_media_credits_person_key/);
        expect(text).toMatch(/idx_media_credits_studio_key/);
    });

    it('writers and producers written by the real upsert path become credits', async () => {
        const { mediaId } = await upsertMediaMetadata(sql, {
            primaryExternalId: '424242',
            mediaType: 'movie',
            title: 'Upserted Movie',
            actors: ['Una Actor'],
            writers: ['Walt Writer'],
            producers: ['Penny Producer'],
            providerMetadata: { production_companies: ['Upsert Films'] },
        });
        const rows = await sql<{ role: string; name: string }[]>`
            SELECT role, name FROM media_credits WHERE media_id = ${mediaId}::uuid ORDER BY role, name`;
        expect(rows).toEqual([
            { role: 'producer', name: 'Penny Producer' },
            { role: 'studio', name: 'Upsert Films' },
            { role: 'writer', name: 'Walt Writer' },
        ]);
    });

    it('an over-long credit name is skipped instead of aborting the metadata write', async () => {
        const long = 'x'.repeat(5000);
        await sql`
            UPDATE provider_metadata
            SET metadata = metadata || ${sql.json({ writers: [long, 'Short Writer'] } as never)}
            WHERE media_id = ${movie}::uuid`;
        const rows = await sql<{ name: string }[]>`
            SELECT name FROM media_credits
            WHERE media_id = ${movie}::uuid AND role = 'writer' ORDER BY name`;
        expect(rows.map((r) => r.name)).toEqual(['Short Writer']);
    });

    it('/Search/Hints offers a Person hint only for people of titles the caller can see', async () => {
        const rated = await seedMovieEmbeddedSubs(sql);
        await sql`UPDATE media_items SET title = 'Rated Movie', age_rating = 18 WHERE id = ${rated.itemId}::uuid`;
        await seedProviderMetadata(sql, rated.itemId, {
            cast: [{ name: 'Rex Rated', character: 'Heavy', person_id: '301' }],
            actors: ['Rex Rated'],
        });
        const { GET } = await import(`${R}/Search/Hints/+server`);
        const hint = async (term: string, user: TestUser): Promise<Dto[]> =>
            (
                await call<{ SearchHints: Dto[] }>(
                    GET,
                    `/Search/Hints?SearchTerm=${term}&IncludeItemTypes=Person`,
                    {},
                    user,
                )
            ).body.SearchHints;

        const ana = await hint('ana', kids);
        expect(ana).toEqual([expect.objectContaining({ Name: 'Ana Actor', Type: 'Person' })]);
        // The Id is the one /Persons issues, and it resolves through /Items/{id}.
        expect(ana[0].Id).toBe(await key('person_key', 'Ana Actor'));
        const { GET: item } = await import(`${R}/Items/[itemId]/+server`);
        expect((await call(item, '', { itemId: ana[0].Id }, kids)).body.Name).toBe('Ana Actor');

        // Credited only in an inaccessible library / an age-blocked title.
        expect(await hint('hank', kids)).toEqual([]);
        expect(await hint('hank', adults)).toHaveLength(1);
        expect(await hint('rex', age12)).toEqual([]);
        expect(await hint('rex', adults)).toHaveLength(1);
    });
});
