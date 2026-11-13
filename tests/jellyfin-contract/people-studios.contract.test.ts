// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cast, crew and studios (BaseItemDto.People / Studios / Tags, Persons,
 * Studios, person and studio ids on /Items) against the jellyfin-sdk-kotlin
 * contract, through the real /j route handlers over real PG + Valkey.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession, type RouteHandler } from './harness';
import { seedEpisodeExternalSrt, seedMovieEmbeddedSubs, seedProviderMetadata } from './seed';
import { GET as itemGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/+server';
import { GET as itemsGet } from '../../src/routes/(proprietary)/j/Items/+server';
import { GET as personsGet } from '../../src/routes/(proprietary)/j/Persons/+server';
import { GET as personGet } from '../../src/routes/(proprietary)/j/Persons/[name]/+server';
import { GET as studiosGet } from '../../src/routes/(proprietary)/j/Studios/+server';
import { GET as studioGet } from '../../src/routes/(proprietary)/j/Studios/[name]/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0df';
let sql: postgres.Sql;
let token: string;
let movieId: string;
let seriesId: string;

interface Dto {
    Id: string;
    Type: string;
    Name: string;
    People?: { Id: string; Name: string; Type: string; PrimaryImageTag?: string }[];
    Studios?: { Id: string; Name: string }[];
    Tags?: string[];
}

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await ensureTestUser(sql, USER_ID);
    const [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
    movieId = (await seedMovieEmbeddedSubs(sql)).itemId;
    await seedProviderMetadata(sql, movieId, {
        cast: [
            { name: 'Contract Lead', character: 'Hero', person_id: '501', has_profile: true },
            { name: 'Contract Support', character: 'Friend' },
        ],
        actors: ['Contract Lead', 'Contract Support'],
        directors: ['Contract Director'],
        writers: ['Contract Writer'],
        producers: ['Contract Producer'],
        production_companies: ['Contract Pictures'],
        keywords: ['contract'],
    });
    seriesId = (await seedEpisodeExternalSrt(sql)).seriesId;
    await seedProviderMetadata(sql, seriesId, {
        actors: ['Contract Support'],
        networks: ['Contract Network'],
    });
});

function get(
    name: string,
    kotlinClass: string,
    handler: RouteHandler,
    path: string,
    params: Record<string, string> = {},
): Promise<unknown> {
    return callAndCheck(
        name,
        kotlinClass,
        handler,
        jfEvent({ method: 'GET', path, token, params }),
    );
}

describe('/j people and studios contract', () => {
    it('Items/{id} — People, Studios, Tags on a movie', async () => {
        const body = (await get(
            'people-item-detail',
            'BaseItemDto',
            itemGet,
            `/j/Items/${movieId}`,
            {
                itemId: movieId,
            },
        )) as Dto;
        expect(body.People!.map((p) => p.Type)).toEqual([
            'Actor',
            'Actor',
            'Director',
            'Writer',
            'Producer',
        ]);
        expect(body.People![0].PrimaryImageTag).toMatch(/^[0-9a-f]{40}$/);
        expect(body.Studios!.map((s) => s.Name)).toEqual(['Contract Pictures']);
        expect(body.Tags).toEqual(['contract']);
    });

    it('Items?PersonIds / StudioIds with Fields=People,Studios', async () => {
        const detail = (await get(
            'people-detail-ids',
            'BaseItemDto',
            itemGet,
            `/j/Items/${movieId}`,
            {
                itemId: movieId,
            },
        )) as Dto;
        const support = detail.People!.find((p) => p.Name === 'Contract Support')!;
        const byPerson = (await get(
            'items-person-ids',
            'BaseItemDtoQueryResult',
            itemsGet,
            `/j/Items?Recursive=true&PersonIds=${support.Id}&Fields=People,Studios,Tags`,
        )) as { Items: Dto[] };
        expect(byPerson.Items.map((i) => i.Id).sort()).toEqual([movieId, seriesId].sort());
        const byStudio = (await get(
            'items-studio-ids',
            'BaseItemDtoQueryResult',
            itemsGet,
            `/j/Items?Recursive=true&StudioIds=${detail.Studios![0].Id}`,
        )) as { Items: Dto[] };
        expect(byStudio.Items.map((i) => i.Id)).toEqual([movieId]);
    });

    it('Persons, Persons/{name}, Items/{personId}', async () => {
        const list = (await get(
            'persons',
            'BaseItemDtoQueryResult',
            personsGet,
            `/j/Persons?userId=${USER_ID}&limit=50`,
        )) as { Items: Dto[] };
        expect(list.Items).toHaveLength(5);
        await get(
            'persons-appears-in',
            'BaseItemDtoQueryResult',
            personsGet,
            `/j/Persons?appearsInItemId=${movieId}&personTypes=Actor`,
        );
        const person = (await get(
            'person-by-name',
            'BaseItemDto',
            personGet,
            `/j/Persons/Contract%20Support`,
            { name: 'Contract Support' },
        )) as Dto;
        expect(person.Type).toBe('Person');
        const viaItems = (await get(
            'person-item',
            'BaseItemDto',
            itemGet,
            `/j/Items/${person.Id}`,
            {
                itemId: person.Id,
            },
        )) as Dto;
        expect(viaItems).toMatchObject({ Id: person.Id, Type: 'Person' });
    });

    it('Studios, Studios/{name}', async () => {
        const list = (await get(
            'studios',
            'BaseItemDtoQueryResult',
            studiosGet,
            `/j/Studios?userId=${USER_ID}`,
        )) as { Items: Dto[] };
        expect(list.Items.map((s) => s.Name)).toEqual(['Contract Network', 'Contract Pictures']);
        const studio = (await get(
            'studio-by-name',
            'BaseItemDto',
            studioGet,
            `/j/Studios/Contract%20Network`,
            { name: 'Contract Network' },
        )) as Dto;
        expect(studio.Type).toBe('Studio');
    });
});
