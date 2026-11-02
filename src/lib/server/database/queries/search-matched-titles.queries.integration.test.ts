// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    unrestrictedAccess,
    denyAllAccess,
    restrictedAccess,
} from './builders/media-access-boundary.js';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { selectMatchedTitle } from '$lib/utils/search/matched-title.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    decorateSearchMatchedTitles,
    storedSearchTitles,
} from './search-matched-titles.queries.js';

describe('bounded stored search titles', () => {
    let sql: postgres.Sql;
    const ids: string[] = [];
    const fileIds: string[] = [];
    const groupIds: string[] = [];
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        if (fileIds.length) await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
        if (ids.length) await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
        if (groupIds.length)
            await sql`DELETE FROM library_groups WHERE id = ANY(${groupIds}::uuid[])`;
        await closeTestDb();
    });
    it('reads only the final page IDs, includes stored original/English, and preserves cached rows', async () => {
        for (const title of ['The Worst Witch', 'Excluded title']) {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, has_files, original_title, english_title)
                VALUES (${title}, 'tv', 'active', true, 'Original title', 'English title') RETURNING id
            `;
            ids.push(row.id);
            await sql`INSERT INTO media_titles (media_id, title, language, kind, source)
                VALUES (${row.id}::uuid, 'Eine lausige Hexe', 'de', 'localized', 'test')`;
        }
        const cached = Object.freeze({ id: ids[0], type: 'series', title: 'The Worst Witch' });
        const source = [cached, { id: 'not-a-uuid', type: 'series', title: 'External' }];
        const decorated = await decorateSearchMatchedTitles(
            sql,
            source,
            'Eine lausige Hexe',
            unrestrictedAccess(),
        );
        expect(decorated[0]).toMatchObject({
            title: 'The Worst Witch',
            matchedTitle: 'Eine lausige Hexe',
        });
        expect(cached).not.toHaveProperty('matchedTitle');
        expect(decorated[0]).not.toBe(cached);
        const overlaid = await decorateSearchMatchedTitles(
            sql,
            [{ ...cached, title: 'Eine lausige Hexe' }],
            'Eine lausige Hexe',
            unrestrictedAccess(),
        );
        expect(overlaid[0]).not.toHaveProperty('matchedTitle');
        expect(decorated[1]).not.toHaveProperty('matchedTitle');
        const stored = await storedSearchTitles(
            sql,
            [ids[0]],
            unrestrictedAccess(),
            'Eine lausige Hexe',
        );
        expect(stored.every((title) => title.media_id === ids[0])).toBe(true);
        // Only rows the database matched against the query come back, and only for requested ids.
        expect(stored.map((title) => title.title)).toEqual(['Eine lausige Hexe']);
        for (const [query, title] of [
            ['original title', 'Original title'],
            ['english', 'English title'],
        ]) {
            const byStored = await storedSearchTitles(sql, [ids[0]], unrestrictedAccess(), query);
            expect(byStored.map((row) => row.title)).toEqual([title]);
        }
        expect(
            await storedSearchTitles(sql, [ids[0]], unrestrictedAccess(), 'no such alias'),
        ).toEqual([]);
        const canonical = await decorateSearchMatchedTitles(
            sql,
            [{ ...cached, title: 'Eine lausige Hexe' }],
            'worst witch',
            unrestrictedAccess(),
        );
        expect(canonical[0]).toMatchObject({ matchedTitle: 'The Worst Witch' });
        expect(
            await storedSearchTitles(sql, [ids[0]], denyAllAccess(), 'Eine lausige Hexe'),
        ).toEqual([]);
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${ids[0]}::uuid`;
        const childAccess = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 12,
            allowUnrated: false,
        });
        expect(await storedSearchTitles(sql, [ids[0]], childAccess, 'Eine lausige Hexe')).toEqual(
            [],
        );
        const denied = await decorateSearchMatchedTitles(
            sql,
            source,
            'Eine lausige Hexe',
            childAccess,
        );
        expect(denied[0]).not.toHaveProperty('matchedTitle');
        expect(await storedSearchTitles(sql, [], unrestrictedAccess(), 'x1')).toEqual([]);
    });
    it('decorates only the returned ids and ignores aliases of other items', async () => {
        const [other] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES ('Unrelated page item', 'movie', 'active', true) RETURNING id`;
        ids.push(other.id);
        await sql`INSERT INTO media_titles (media_id, title, language, kind, source)
            VALUES (${other.id}::uuid, 'Zebra Quartz Alias', 'en', 'localized', 'test')`;
        const rows = await storedSearchTitles(sql, [ids[0]], unrestrictedAccess(), 'zebra quartz');
        expect(rows).toEqual([]);
        const decorated = await decorateSearchMatchedTitles(
            sql,
            [{ id: ids[0], type: 'series', title: 'The Worst Witch' }],
            'zebra quartz',
            unrestrictedAccess(),
        );
        expect(decorated[0]).not.toHaveProperty('matchedTitle');
    });
    it('matches accents and case in SQL and lets the SQL match win', async () => {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES ('Plain primary', 'movie', 'active', true) RETURNING id`;
        ids.push(row.id);
        await sql`INSERT INTO media_titles (media_id, title, language, kind, source) VALUES
            (${row.id}::uuid, 'Élan Vital Extended', 'fr', 'localized', 'test'),
            (${row.id}::uuid, 'Élan Vital', 'fr', 'localized', 'test')`;
        const [decorated] = await decorateSearchMatchedTitles(
            sql,
            [
                { id: row.id, type: 'movie', title: 'Plain primary' } as {
                    id: string;
                    type: string;
                    title: string;
                    matchedTitle?: string;
                },
            ],
            'ELAN vital',
            unrestrictedAccess(),
        );
        expect(decorated.matchedTitle).toBe('Élan Vital');
    });
    it('keeps results and drops the decoration when the lookup hits its timeout', async () => {
        const slow = new Proxy(sql, {
            get(target, prop, receiver) {
                if (prop === 'begin')
                    return async (fn: (trx: postgres.Sql) => Promise<unknown>) =>
                        target.begin(async (trx) => {
                            await trx.unsafe('SET LOCAL statement_timeout = 1');
                            await trx`SELECT pg_sleep(0.2)`;
                            return fn(trx as unknown as postgres.Sql);
                        });
                return Reflect.get(target, prop, receiver);
            },
        }) as postgres.Sql;
        const page = [{ id: ids[0], type: 'series', title: 'The Worst Witch' }];
        const decorated = await decorateSearchMatchedTitles(
            slow,
            page,
            'Eine lausige Hexe',
            unrestrictedAccess(),
        );
        expect(decorated).toEqual(page);
        expect(decorated[0]).not.toHaveProperty('matchedTitle');
    });
    it('uses the same Latin accent folds as the database search', async () => {
        for (const [stored, plain] of [
            ['Łowca', 'Lowca'],
            ['Ørnen', 'Ornen'],
            ['Đavolji', 'Davolji'],
            ['Ðagur', 'Dagur'],
            ['Þor', 'Thor'],
            ['Æon Flux', 'Aeon Flux'],
            ['Œuvre', 'Oeuvre'],
        ]) {
            const [row] = await sql<{ folded: string }[]>`
                SELECT lower(immutable_unaccent(${stored})) AS folded
            `;
            expect(row.folded).toBe(plain.toLowerCase());
            expect(selectMatchedTitle('Other title', row.folded, [stored])).toBe(stored);
        }
    });

    it('reads aliases only from allowed movie files and allowed series descendants', async () => {
        const allowedGroup = randomUUID();
        const deniedGroup = randomUUID();
        groupIds.push(allowedGroup, deniedGroup);
        await sql`INSERT INTO library_groups (id, name) VALUES
            (${allowedGroup}::uuid, ${'matched-allowed-' + allowedGroup}),
            (${deniedGroup}::uuid, ${'matched-denied-' + deniedGroup})`;
        async function media(type: string, parentId: string | null = null): Promise<string> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, parent_id, status, has_files)
                VALUES ('Canonical fixture', ${type}, ${parentId}::uuid, 'active', true) RETURNING id
            `;
            ids.push(row.id);
            await sql`INSERT INTO media_titles (media_id, title, language, kind, source)
                VALUES (${row.id}::uuid, 'Stored alias', 'en', 'localized', 'test')`;
            return row.id;
        }
        async function file(mediaId: string, groupId: string, isDefault = true): Promise<void> {
            const id = randomUUID();
            fileIds.push(id);
            await sql`INSERT INTO media_files (id, file_path, library_group_id)
                VALUES (${id}::uuid, ${'/matched-titles/' + id + '.mkv'}, ${groupId}::uuid)`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${id}::uuid, ${mediaId}::uuid, ${isDefault})`;
        }
        const allowedMovie = await media('movie');
        const deniedMovie = await media('movie');
        const series = await media('tv');
        const season = await media('season', series);
        const episode = await media('episode', season);
        await file(allowedMovie, allowedGroup);
        await file(deniedMovie, deniedGroup);
        await file(episode, deniedGroup);
        const access = restrictedAccess({
            deniedGroupIds: [deniedGroup],
            maxAgeRating: null,
            allowUnrated: true,
        });
        const page = [
            { id: allowedMovie, type: 'movie', title: 'Canonical fixture' },
            { id: deniedMovie, type: 'movie', title: 'Canonical fixture' },
            { id: series, type: 'series', title: 'Canonical fixture' },
        ];
        const stored = await storedSearchTitles(
            sql,
            page.map((item) => item.id),
            access,
            'Stored alias',
        );
        expect([...new Set(stored.map((row) => row.media_id))]).toEqual([allowedMovie]);
        const decorated = await decorateSearchMatchedTitles(sql, page, 'Stored alias', access);
        expect(decorated[0]).toMatchObject({ matchedTitle: 'Stored alias' });
        expect(decorated[1]).not.toHaveProperty('matchedTitle');
        expect(decorated[2]).not.toHaveProperty('matchedTitle');
        // A series with any accessible descendant is visible, even alongside denied files.
        await file(episode, allowedGroup, false);
        const mixed = await decorateSearchMatchedTitles(sql, page, 'Stored alias', access);
        expect(mixed[2]).toMatchObject({ matchedTitle: 'Stored alias' });
        expect(page.every((item) => !('matchedTitle' in item))).toBe(true);
    });
});
